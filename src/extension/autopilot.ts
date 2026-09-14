import { GameState, PlayerId, RESOURCES, Resource, pips } from "../engine/types";
import { vertexPips } from "../engine/board";
import { evaluateBuilds, turnsToAfford, BuildEvaluation } from "../engine/horizon";
import { PlanningContext, planPosition } from "./planning";
import { confirmedMonopolyHaul } from "./handLedger";
import { distanceFromPlayer, isVertexBuildable, playerProduction } from "../engine/analysis";
import { pixelToColonistCorner, pixelsToColonistEdge } from "./coords";
import { DomActionKind, tryDomAction, tryDomDiscard } from "./domActions";
import { ActionKind, ProtocolLearner } from "./protocolLearner";
import {
  LiveStrategyFit,
  deckStatus,
  expectedProduction,
  planDiscard,
  productionTotal,
} from "./copilot";
import { PlacementAdvice } from "./placement";
import {
  RESOURCE_TO_CARD_ID,
  TrackerState,
  PlayerState,
  handTotal,
  visibleVp,
  inferOpponentDevCards,
} from "./tracker";
import { TradeOffer, decideTradeResponse, proposeTrade } from "./trading";

export interface AutopilotDecision {
  kind: ActionKind;
  coord?: { x: number; y: number; z?: number };
  /** for "discard": how many of each resource to give up */
  cards?: Partial<Record<Resource, number>>;
  /** for "bank-trade": give `giveCount` of `give` to get one `get` */
  trade?: { give: Resource; get: Resource; giveCount: number };
  /** for "play-monopoly": the resource to steal from everyone */
  resource?: Resource;
  /** for "play-year-of-plenty": the two resources to take from the bank */
  resources?: [Resource, Resource];
  /** for "build-road": a free Road Building placement (no intent, no cost) */
  free?: boolean;
  /** for "trade-response": which offer, and our answer */
  tradeId?: string;
  accept?: boolean;
  /** for "propose-trade": what we give and what we ask */
  offer?: { offered: Partial<Record<Resource, number>>; wanted: Partial<Record<Resource, number>> };
  describe: string;
  evaluation?: { horizon: number; gap: number; alternatives: Array<{ kind: string; score: number; wait: number; vertexId?: number }> };
}

/** The builds we're saving for, in order, as costs — the plan a trade must serve. */
export function planCosts(fit: LiveStrategyFit | null, _vp: number, _target = 10): Array<Partial<Record<Resource, number>>> {
  const order: Array<keyof typeof BUILD_COSTS> =
    fit ? fit.strategy.buildOrder.filter((i) => i !== "road") : ["city", "settlement"];
  return order.map((i) => BUILD_COSTS[i]);
}

const BUILD_COSTS: Record<"road" | "settlement" | "city" | "dev", Partial<Record<Resource, number>>> = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { ore: 3, wheat: 2 },
  dev: { ore: 1, sheep: 1, wheat: 1 },
};

type BankTrade = { give: Resource; get: Resource; giveCount: number };

/** Minimum think time before committing the game's first settlement placement. */
const FIRST_SETTLEMENT_THINK_MS = 30_000;

/**
 * Win probability estimation: compares your position vs opponent.
 * Factors: VP delta, production delta, dev card threat, resource position.
 * Returns 0-1 probability of winning.
 */
export interface WinProbability {
  probability: number; // 0-1
  factors: {
    vpDelta: number; // your VP - opponent VP
    productionDelta: number; // your pips/36 - opponent pips/36
    devCardThreat: number; // opponent's inferred dev card danger
    resourceRisk: number; // your hand vulnerability to monopoly/7
    hasLargestArmy: boolean;
    hasLongestRoad: boolean;
  };
  reasoning: string[];
}

export function estimateWinProbability(
  you: PlayerState,
  opponent: PlayerState,
  state: TrackerState,
  board: GameState["board"] | null,
  robberHex: { x: number; y: number } | null,
  allBuildings: GameState["buildings"] | null,
): WinProbability {
  const reasoning: string[] = [];
  const yourVp = visibleVp(you);
  const oppVp = visibleVp(opponent);
  const vpDelta = yourVp - oppVp;

  // Production delta (expected cards per roll)
  const yourProd = productionTotal(expectedProduction(you));
  const oppProd = productionTotal(expectedProduction(opponent));
  const productionDelta = yourProd - oppProd;

  // Dev card inference
  const devInference = inferOpponentDevCards(opponent, robberHex, state, board, allBuildings);
  let devCardThreat = 0;
  if (devInference.likelyMonopoly) devCardThreat += 0.15;
  if (devInference.likelyVpCard && oppVp >= 8) devCardThreat += 0.25;
  if (devInference.likelyKnight) devCardThreat += 0.1;
  if (devInference.likelyRoadBuilding && oppVp >= 7) devCardThreat += 0.1;
  if (devInference.likelyYearOfPlenty) devCardThreat += 0.1;

  // Resource risk: how vulnerable is your hand to monopoly/7
  const yourHandTotal = handTotal(you);
  const maxHandResource = Math.max(...RESOURCES.map(r => you.hand[r]));
  let resourceRisk = 0;
  if (yourHandTotal > state.discardLimit) resourceRisk += 0.1;
  if (maxHandResource >= 5) resourceRisk += 0.1; // monopoly target
  if (devInference.likelyMonopoly && maxHandResource >= 4) resourceRisk += 0.15;

  // Army/road bonuses
  const youHoldLA = you.knightsPlayed >= 3 && you.knightsPlayed > opponent.knightsPlayed;
  const oppHoldLA = opponent.knightsPlayed >= 3 && opponent.knightsPlayed > you.knightsPlayed;
  const youHoldLR = you.roads >= 5 && you.roads > opponent.roads;
  const oppHoldLR = opponent.roads >= 5 && opponent.roads > you.roads;

  // Base probability from VP (each VP ~10% win chance in 1v1)
  let probability = 0.5 + vpDelta * 0.1;

  // Production advantage (each pip/36 ~5%)
  probability += productionDelta * 0.05;

  // Dev card threat reduces your chance
  probability -= devCardThreat;

  // Resource risk reduces your chance
  probability -= resourceRisk;

  // Army/road
  if (youHoldLA) { probability += 0.1; reasoning.push("You hold Largest Army (+2 VP)"); }
  if (oppHoldLA) { probability -= 0.1; reasoning.push("Opponent holds Largest Army (-2 VP)"); }
  if (youHoldLR) { probability += 0.1; reasoning.push("You hold Longest Road (+2 VP)"); }
  if (oppHoldLR) { probability -= 0.1; reasoning.push("Opponent holds Longest Road (-2 VP)"); }

  // Clamp
  probability = Math.max(0.05, Math.min(0.95, probability));

  if (vpDelta > 0) reasoning.push(`Leading by ${vpDelta} VP`);
  else if (vpDelta < 0) reasoning.push(`Trailing by ${-vpDelta} VP`);
  if (productionDelta > 0.1) reasoning.push(`Production advantage (${yourProd.toFixed(2)} vs ${oppProd.toFixed(2)} cards/roll)`);
  else if (productionDelta < -0.1) reasoning.push(`Production deficit (${yourProd.toFixed(2)} vs ${oppProd.toFixed(2)} cards/roll)`);
  if (devCardThreat > 0) reasoning.push(`Opponent dev card threat: ${devInference.reasoning.join(", ")}`);
  if (resourceRisk > 0) reasoning.push(`Your hand vulnerable to monopoly/7 (${yourHandTotal} cards, max ${maxHandResource})`);

  return {
    probability,
    factors: {
      vpDelta,
      productionDelta,
      devCardThreat,
      resourceRisk,
      hasLargestArmy: youHoldLA,
      hasLongestRoad: youHoldLR,
    },
    reasoning,
  };
}

/**
 * Delta-based decision: maximize (your outcome - opponent outcome).
 * Instead of just maximizing your EV, consider what hurts opponent most.
 */
export interface DeltaDecision {
  action: string;
  yourGain: number; // expected VP gain for you
  opponentLoss: number; // expected VP loss for opponent (blocking them)
  netDelta: number; // yourGain + opponentLoss
  reasoning: string;
}

/** Can we afford `cost` after trading surplus at these bank/port ratios? */
export function affordableWithTrades(
  hand: Record<Resource, number>,
  ratios: Partial<Record<Resource, number>>,
  cost: Partial<Record<Resource, number>>,
): boolean {
  let missing = 0;
  for (const r of RESOURCES) missing += Math.max(0, (cost[r] ?? 0) - hand[r]);
  if (missing === 0) return true;
  // cards we can mint from surplus (each `ratio` spare of a resource -> 1 card)
  let power = 0;
  for (const r of RESOURCES) {
    const spare = hand[r] - (cost[r] ?? 0);
    if (spare > 0) power += Math.floor(spare / (ratios[r] ?? 4));
  }
  return power >= missing;
}

/**
 * One bank/port trade toward affording `cost`: give surplus of the resource
 * the strategy values least (at its ratio) to get the card the build is most
 * short of. Null when no tradeable surplus exists.
 */
export function tradeTowardCost(
  hand: Record<Resource, number>,
  ratios: Partial<Record<Resource, number>>,
  cost: Partial<Record<Resource, number>>,
  weights: Record<Resource, number>,
): BankTrade | null {
  let need: Resource | null = null;
  let needGap = 0;
  for (const r of RESOURCES) {
    const gap = (cost[r] ?? 0) - hand[r];
    if (gap > needGap) {
      needGap = gap;
      need = r;
    }
  }
  if (!need) return null;
  let best: { give: Resource; ratio: number; score: number } | null = null;
  for (const g of RESOURCES) {
    if (g === need) continue;
    const ratio = ratios[g] ?? 4; // ground-truth port ratio (2/3) or 4:1 bank
    const surplus = hand[g] - (cost[g] ?? 0);
    if (surplus < ratio) continue; // can't trade this away without hurting the build
    // Port-aware: a lower ratio (a 2:1/3:1 port) dominates, so we never burn 4
    // cards when a port would cost 2. Then prefer the least-valued resource and,
    // last, the most spare.
    const score = -ratio * 100 - weights[g] * 5 + surplus;
    if (!best || score > best.score) best = { give: g, ratio, score };
  }
  return best ? { give: best.give, get: need, giveCount: best.ratio } : null;
}

/** A trade toward the strategy's first not-yet-affordable build (over-limit dump). */
export function planBankTrade(
  hand: Record<Resource, number>,
  ratios: Partial<Record<Resource, number>>,
  fit: LiveStrategyFit,
  canBuild: (item: keyof typeof BUILD_COSTS) => boolean = () => true,
): BankTrade | null {
  for (const item of fit.strategy.buildOrder) {
    if (!canBuild(item)) continue; // bank/supply exhausted for this build
    const cost = BUILD_COSTS[item];
    const short = RESOURCES.some((r) => (cost[r] ?? 0) > hand[r]);
    if (!short) return null; // already affordable — build, don't trade
    const trade = tradeTowardCost(hand, ratios, cost, fit.strategy.weights);
    if (trade) return trade;
  }
  return null;
}

/** Trade surplus (4+ of one resource) to avoid 7-discard: give the least-valued
 *  surplus resource at its best ratio for the most-needed resource by strategy.
 *  Only trades if there's at least one buildable SPATIAL target (settlement/city/road)
 *  in the plan — dev cards alone don't justify a 4:1 dump. */
export function tradeSurplusToAvoidDiscard(
  hand: Record<Resource, number>,
  ratios: Partial<Record<Resource, number>>,
  weights: Record<Resource, number>,
  limit: number,
  order: ReadonlyArray<keyof typeof BUILD_COSTS>,
  fundingTarget: (item: keyof typeof BUILD_COSTS) => Partial<Record<Resource, number>> | null,
  /** how many cards before the limit the caller starts shedding (2 normal, 3 when a 7 is due / protecting) */
  dist = 2,
): BankTrade | null {
  const total = RESOURCES.reduce((s, r) => s + hand[r], 0);
  if (total < limit - dist) return null; // not close enough to limit to worry

  // Find the first buildable spatial target and treat the gap as the need:
  // trade toward what we actually want to build, not abstract strategy weight.
  const spatialItems: Array<keyof typeof BUILD_COSTS> = ["settlement", "city", "road"];
  let need: Resource | null = null;
  let needGap = 0;
  for (const item of order) {
    if (!spatialItems.includes(item)) continue;
    const cost = fundingTarget(item);
    if (!cost) continue;
    for (const r of RESOURCES) {
      const gap = (cost[r] ?? 0) - hand[r];
      if (gap > needGap) {
        needGap = gap;
        need = r;
      }
    }
    if (need) break; // use the first buildable target's biggest gap
  }
  // No buildable spatial target → nothing to trade toward, hold the hand.
  // The old weight-based fallback produced spurious trades (e.g. dumping wood
  // for brick when there's no settlement to place or city to upgrade).
  if (!need) return null;

  // Pick the surplus with the best ratio (highest bank rate first) that isn't
  // the need resource — shed the most cards per trade to reduce 7 risk.
  const surpluses: Array<{ resource: Resource; count: number; ratio: number }> = [];
  for (const r of RESOURCES) {
    const ratio = ratios[r] ?? 4;
    if (hand[r] >= ratio && r !== need) surpluses.push({ resource: r, count: hand[r], ratio });
  }
  if (surpluses.length === 0) return null;

  surpluses.sort((a, b) =>
    a.ratio - b.ratio || weights[a.resource] - weights[b.resource],
  );
  const give = surpluses[0].resource;
  const ratio = surpluses[0].ratio;
  return { give, get: need, giveCount: ratio };
}

/** Flatten a discard plan into colonist wire card ids. */
export function cardsToIds(cards: Partial<Record<Resource, number>>): number[] {
  const ids: number[] = [];
  for (const [r, n] of Object.entries(cards)) {
    for (let i = 0; i < (n ?? 0); i++) ids.push(RESOURCE_TO_CARD_ID[r as Resource]);
  }
  return ids;
}

function describeCards(cards: Partial<Record<Resource, number>>): string {
  return Object.entries(cards)
    .map(([r, n]) => `${n} ${r}`)
    .join(" + ");
}

/**
 * Choose the robber tile: maximize the value denied to opponents (pips ×
 * buildings) minus the value denied to yourself, never re-placing on the
 * current robber tile. Respects friendly robber via `canRob`: a tile with any
 * un-robbable opponent (< 3 VP) is illegal to place on — colonist rejects it —
 * so we skip it and, if nothing is robbable, move the robber to a neutral tile.
 */
/**
 * The opponent's thinnest produced resource (their choke point). Blocking a
 * tile of a resource they barely produce deepens the shortage they can least
 * afford; returns null when they produce nothing observable.
 */
export function opponentStarveResource(state: GameState, oppPlayer: PlayerId): Resource | null {
  const prod = playerProduction(state, oppPlayer);
  let worst: Resource | null = null;
  let worstVal = Infinity;
  for (const r of RESOURCES) {
    if (prod[r] > 0 && prod[r] < worstVal) {
      worstVal = prod[r];
      worst = r;
    }
  }
  return worst;
}

/**
 * Chess-style risk profile from the win-probability estimate: far behind ->
 * buy variance (lotto tickets: dev cards, gambits); comfortably ahead ->
 * shed variance early (dump before 7s, protect the lead).
 */
export type RiskMode = "lotto" | "neutral" | "protect";
export function riskModeOf(probability: number): RiskMode {
  if (probability <= 0.35) return "lotto";
  if (probability >= 0.65) return "protect";
  return "neutral";
}

export function bestRobberHex(
  state: GameState,
  youPlayer: PlayerId,
  current: { x: number; y: number } | null,
  canRob: (player: PlayerId) => boolean = () => true,
  /** conditional P(next roll = n) from the balanced-dice shoe count */
  probOf?: (n: number) => number,
  /** the victim's thinnest produced resource — tiles of it score 1.4x */
  starve?: Resource | null,
  planning?: PlanningContext,
): { hex: { x: number; y: number }; victim: PlayerId | null; describe: string } | null {
  const oppOnTile = (hexId: number) =>
    state.buildings.filter(
      (b) => b.player !== youPlayer && state.board.vertices[b.vertexId].hexIds.includes(hexId),
    );
  // Friendly robber: the tile is legal only if NO opponent on it is un-robbable.
  const tileLegal = (hexId: number) => oppOnTile(hexId).every((b) => canRob(b.player));

  // Blocking value scales with how likely the token is to ROLL NEXT, not just
  // its static pip weight: with balanced dice a due 9 beats an exhausted 6.
  const combosOf = (token: number): number => {
    if (!probOf) return pips(token);
    return Math.max(0.25, probOf(token) * 36);
  };

  let best: { score: number; hexId: number } | null = null;
  for (const hex of state.board.hexes) {
    if (hex.kind === "desert" || hex.token === null) continue;
    if (current && hex.q === current.x && hex.r === current.y) continue;
    if (!tileLegal(hex.id)) continue;
    let opp = 0;
    let mine = 0;
    for (const b of state.buildings) {
      if (!state.board.vertices[b.vertexId].hexIds.includes(hex.id)) continue;
      const value =
        combosOf(hex.token) *
        (b.kind === "city" ? 2 : 1) *
        (!planning && starve && hex.kind === starve ? 1.4 : 1);
      if (b.player === youPlayer) mine += value;
      else opp += value;
    }
    let bottleneck = 0;
    if (planning) for (const input of planning.inputs.filter((p) => !p.isYou)) {
      const pid = input.playerId;
      if (pid === undefined) continue;
      const units = state.buildings.filter((b) => b.player === pid && state.board.vertices[b.vertexId].hexIds.includes(hex.id))
        .reduce((s, b) => s + (b.kind === "city" ? 2 : 1), 0);
      if (!units) continue;
      const goal = planning.victories.find((p) => p.name === input.name)?.steps[0]?.cost ?? BUILD_COSTS.city;
      const rate = Object.fromEntries(RESOURCES.map((r) => [r, input.production[r] * (input.rollsPerTurn ?? 2)])) as Record<Resource, number>;
      const blocked = { ...rate, [hex.kind]: Math.max(0, rate[hex.kind] - pips(hex.token) / 36 * units * (input.rollsPerTurn ?? 2)) };
      const before = turnsToAfford(goal, input.hand, rate, input.bankRatios);
      const after = turnsToAfford(goal, input.hand, blocked, input.bankRatios);
      const horizon = planning.horizon.turns + 1;
      bottleneck += Math.max(0, Math.min(horizon, after) - Math.min(horizon, before)) * 6 / horizon;
    }
    const score = opp - mine * 1.5 + bottleneck;
    if (opp > 0 && (!best || score > best.score)) best = { score, hexId: hex.id };
  }

  if (best) {
    const hex = state.board.hexes[best.hexId];
    const victim = oppOnTile(best.hexId)[0]?.player ?? null;
    const starving = starve && hex.kind === starve;
    return {
      hex: { x: hex.q, y: hex.r },
      victim,
      describe: `robber to the ${hex.token}-${hex.kind} tile${starving ? ` — starving their ${hex.kind} choke` : ""}`,
    };
  }

  // Nothing robbable (friendly robber + every opponent under 3 VP): the robber
  // still must move to a LEGAL tile. Rather than an arbitrary empty tile, park
  // it where the opponent is EXPANDING TOWARD — the best open corner on or
  // next to their road network — so the placement denies their next claim even
  // though it can't steal.
  const oppPlayers = new Set(
    state.buildings.filter((b) => b.player !== youPlayer).map((b) => b.player),
  );
  const expansionBlock = ((): { hexId: number; score: number } | null => {
    if (oppPlayers.size === 0) return null;
    let best: { hexId: number; score: number } | null = null;
    for (const h of state.board.hexes) {
      if (h.kind === "desert" || h.token === null) continue;
      if (current && h.q === current.x && h.r === current.y) continue;
      if (!tileLegal(h.id)) continue;
      let blockScore = 0;
      for (const v of state.board.vertices) {
        if (!v.hexIds.includes(h.id)) continue;
        if (!isVertexBuildable(state, v.id)) continue;
        // how imminent is this corner for an opponent? road-distance from
        // their network: 0-1 edges = settling now, 2 = building toward it.
        let dist = Infinity;
        for (const op of oppPlayers) {
          dist = Math.min(dist, distanceFromPlayer(state, op, v.id));
        }
        if (dist > 2) continue;
        blockScore += vertexPips(state.board, v.id) * (3 - dist);
      }
      if (blockScore > 0 && (!best || blockScore > best.score)) best = { hexId: h.id, score: blockScore };
    }
    return best;
  })();
  if (expansionBlock) {
    const hex = state.board.hexes[expansionBlock.hexId];
    return {
      hex: { x: hex.q, y: hex.r },
      victim: null,
      describe: `robber to the ${hex.token}-${hex.kind} tile — blocks the spot they're expanding into (friendly robber — no one has 3+ points to rob)`,
    };
  }

  // No opponent-expansion signal (or no legal such tile): fall back to any
  // empty tile so we block no one, including ourselves.
  const neutral =
    state.board.hexes.find(
      (h) =>
        h.kind !== "desert" &&
        !(current && h.q === current.x && h.r === current.y) &&
        state.buildings.every((b) => !state.board.vertices[b.vertexId].hexIds.includes(h.id)),
    ) ?? state.board.hexes.find((h) => h.kind !== "desert" && tileLegal(h.id));
  if (!neutral) return null;
  return {
    hex: { x: neutral.q, y: neutral.r },
    victim: null,
    describe: `robber to a neutral tile (friendly robber — no one has 3+ points to rob)`,
  };
}

const COSTS: Record<"road" | "settlement" | "city" | "dev", Partial<Record<string, number>>> = {
  road: { wood: 1, brick: 1 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  city: { ore: 3, wheat: 2 },
  dev: { ore: 1, sheep: 1, wheat: 1 },
};

/** Best legal settlement spot connected to the player's road network, now. */
export function bestPlaceableNow(state: GameState, player: PlayerId): number | null {
  const network = new Set<number>();
  for (const b of state.buildings) if (b.player === player) network.add(b.vertexId);
  for (const r of state.roads) {
    if (r.player === player) {
      const e = state.board.edges[r.edgeId];
      network.add(e.a);
      network.add(e.b);
    }
  }
  let best: number | null = null;
  let bestPips = -1;
  for (const v of network) {
    if (!isVertexBuildable(state, v)) continue;
    const p = vertexPips(state.board, v);
    if (p > bestPips) {
      bestPips = p;
      best = v;
    }
  }
  return best;
}

/**
 * Best edge for a FREE road (Road Building): an untaken edge extending the
 * player's network, preferring one whose far end is a legal settlement corner
 * (that's the expansion we played the card for), then by that corner's pips.
 */
export function bestFreeRoadEdge(state: GameState, player: PlayerId): number | null {
  const network = new Set<number>();
  for (const b of state.buildings) if (b.player === player) network.add(b.vertexId);
  for (const r of state.roads) {
    if (r.player === player) {
      const e = state.board.edges[r.edgeId];
      network.add(e.a);
      network.add(e.b);
    }
  }
  const taken = new Set(state.roads.map((r) => r.edgeId));
  const oppBuildings = new Set(
    state.buildings.filter((b) => b.player !== player).map((b) => b.vertexId),
  );
  let best: number | null = null;
  let bestScore = -1;
  for (const e of state.board.edges) {
    if (taken.has(e.id)) continue;
    const aIn = network.has(e.a);
    const bIn = network.has(e.b);
    if (!aIn && !bIn) continue;
    const from = aIn ? e.a : e.b;
    if (oppBuildings.has(from)) continue; // roads can't pass an opponent's building
    const far = aIn ? e.b : e.a;
    const score = vertexPips(state.board, far) + (isVertexBuildable(state, far) ? 6 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = e.id;
    }
  }
  return best;
}

/**
 * Pure decision: given the current game view, what should autopilot do next?
 * Returns null when there is nothing (sensible) left to do this turn.
 */
export function decideNext(opts: {
  tracker: TrackerState;
  youName: string;
  fit: LiveStrategyFit | null;
  gs: { state: GameState; youPlayer: PlayerId | null } | null;
  advice: PlacementAdvice | null;
  rolledThisTurn: boolean;
  robberPending?: boolean;
  robberHex?: { x: number; y: number } | null;
  discardPending?: boolean;
  discardLimit?: number;
  /** a knight card is in hand and playable this turn (not bought this turn) */
  knightAvailable?: boolean;
  /** dev cards left in the bank; 0 = sold out, never try to buy (null = unknown) */
  bankDevCards?: number | null;
  /** building pieces left in our supply; 0 = can't build that piece (null = unknown) */
  piecesLeft?: { settlements: number | null; cities: number | null; roads: number | null };
  /** we hold a playable monopoly card this turn */
  hasMonopoly?: boolean;
  /** we hold a playable road building card this turn */
  hasRoadBuilding?: boolean;
  /** we hold a playable year of plenty card this turn */
  hasYearOfPlenty?: boolean;
  /** free roads still owed from a played Road Building (game is blocked on them) */
  freeRoadsPending?: number;
  /** friendly robber: whether a given player may be robbed (>= 3 VP) */
  canRob?: (player: PlayerId) => boolean;
  /** victory points to win (colonist: 10; casual 1v1: 15). Default 10. */
  winTarget?: number;
  /** our cheapest next VP step from the path-to-victory analysis (endgame steering) */
  endgameStep?: "city" | "settlement" | "dev" | "road";
  planning?: PlanningContext;
  /** Victory Point dev cards we hold (exact, from card ids) — count toward the target */
  vpCardsHeld?: number;
  /** player trading is possible (3+ players; colonist 1v1 has none) and we may still propose this turn */
  canProposeTrade?: boolean;
  /** resources we've already asked for this turn (rotate, don't repeat) */
  askedThisTurn?: Resource[];
  /**
   * Restrict the kinds of action this decision may return (e.g. Rush mode:
   * placements + robber only). Omitted = everything, the normal turn game.
   */
  allow?: ReadonlySet<ActionKind>;
}): AutopilotDecision | null {
  const { tracker, youName, fit, gs, advice, rolledThisTurn, robberPending, robberHex, discardPending } =
    opts;
  const you = tracker.players.get(youName);
  if (!you) return null;
  const allowed = (kind: ActionKind): boolean => !opts.allow || opts.allow.has(kind);
  const board = gs?.state.board ?? null;
  const limit = opts.discardLimit ?? tracker.discardLimit;
  const handSize = handTotal(you);
  const planning = opts.planning ?? planPosition(tracker, youName, gs, {
    target: opts.winTarget, robberHex: opts.robberHex, hiddenVp: opts.vpCardsHeld, pieces: opts.piecesLeft,
    devDeckLeft: opts.bankDevCards, knightsInHand: opts.knightAvailable ? 1 : 0, playableKnights: opts.knightAvailable ? 1 : 0,
  });

  // Balanced-dice shoe: conditional P(next roll = n) from the counted deck
  // drives robber targeting (block the number likeliest to roll) and the
  // 7-risk timing of anti-discard trading.
  const deck = deckStatus(tracker);
  const probOf = (n: number): number => deck.prob.get(n) ?? pips(n) / 36;

  // Forced discard (a 7 while over the limit) resolves before anything else:
  // pick the worst cards ourselves instead of letting the game choose.
  if (discardPending && handSize > limit) {
    const cards = planDiscard(you.hand, Math.floor(handSize / 2), fit, planning.builds[0]?.cost, planning.weights);
    return {
      kind: "discard",
      cards,
      describe: `discard ${describeCards(cards)} (keeping the next build)`,
    };
  }

  // Robber placement takes priority: it blocks everything until resolved.
  if (robberPending && gs && gs.youPlayer !== null && board) {
    const target = bestRobberHex(gs.state, gs.youPlayer, robberHex ?? null, opts.canRob, probOf, undefined, planning);
    if (target) {
      return {
        kind: "move-robber",
        coord: { x: target.hex.x, y: target.hex.y },
        describe: target.describe,
      };
    }
    return null; // no useful tile — let the human decide
  }

  const freeRoadChoices = (count: number) => evaluateBuilds(planning.options.filter((b) => b.roadEdges?.length).map((b) => {
    const free = Math.min(count, b.roadEdges!.length);
    return { ...b, cost: { ...b.cost, wood: (b.cost.wood ?? 0) - free, brick: (b.cost.brick ?? 0) - free } };
  }), you.hand, planning.production, you.bankRatio, planning.remaining, planning.gap, planning.horizon);

  // Road Building placement: a played card owes the game free roads — it
  // blocks everything else until they're placed. Follow the advised expansion
  // path first; otherwise extend toward the best reachable corner.
  if ((opts.freeRoadsPending ?? 0) > 0 && board && gs && gs.youPlayer !== null) {
    const advised = (freeRoadChoices(opts.freeRoadsPending!)[0]?.roadEdges ?? advice?.roadEdges ?? []).find(
      (id) => !gs.state.roads.some((r) => r.edgeId === id),
    );
    const edgeId = advised ?? bestFreeRoadEdge(gs.state, gs.youPlayer);
    if (edgeId !== null && edgeId !== undefined) {
      const e = board.edges[edgeId];
      const coord = pixelsToColonistEdge(board.vertices[e.a], board.vertices[e.b]);
      if (coord) {
        return { kind: "build-road", coord, free: true, describe: "place a free road (Road Building)" };
      }
    }
    return null; // no sensible edge — let the human place it
  }

  // Setup phase: place the advised settlement / road (needs the board).
  if (advice?.phase === "setup" && board && gs && gs.youPlayer !== null) {
    if (advice.roadEdges.length > 0) {
      const e = board.edges[advice.roadEdges[0]];
      const coord = pixelsToColonistEdge(board.vertices[e.a], board.vertices[e.b]);
      if (coord) return { kind: "build-road", coord, describe: "setup road (dashed edge)" };
      return null;
    }
    if (advice.spots.length > 0) {
      const v = board.vertices[advice.spots[0].vertexId];
      const coord = pixelToColonistCorner(v.x, v.y);
      if (coord) return { kind: "build-settlement", coord, describe: `settlement at ① ${advice.spots[0].label}` };
    }
    return null;
  }

  // Knight discipline (from game-log analysis: 13 knights played was wasteful).
  // Play a knight ONLY to un-block your own tile, or to take/hold Largest Army
  // when it MATTERS for the win — not greedily. Once you hold it, HOLD the rest.
  // DON'T play if an opponent is already blocked — save it for when YOU are blocked.
  // Otherwise, use the robber as robber utility (block the strongest opponent).
  const knightReason = ((): string | null => {
    if (!opts.knightAvailable || !allowed("play-knight")) return null;

    const blockedMine =
      !!robberHex &&
      !!gs &&
      gs.youPlayer !== null &&
      !!board &&
      gs.state.buildings.some(
        (b) =>
          b.player === gs.youPlayer &&
          board.vertices[b.vertexId].hexIds.some(
            (h) => board.hexes[h].q === robberHex.x && board.hexes[h].r === robberHex.y,
          ),
      );
    if (blockedMine) return "the robber is on your tile";

    const me = planning.inputs.find((p) => p.isYou);
    const armyStep = planning.victories.find((p) => p.isYou)?.steps.find((s) => s.kind === "largest-army");
    if (!me?.holdsLargestArmy && armyStep) return "advance the planned Largest Army route before its play deadline";
    return null;
  })();

  // Knight timing: play it BEFORE rolling by default (move the robber / grow
  // the army first). But if you're holding enough that a 7 would force a
  // discard (over the limit), roll first — then play it — so it isn't spent
  // into a discard.
  const overLimit = handSize > limit;
  if (knightReason && !rolledThisTurn && !overLimit) {
    return { kind: "play-knight", describe: `play a knight before rolling — ${knightReason}` };
  }

  if (!rolledThisTurn) return { kind: "roll", describe: "roll the dice" };
  if (!fit) return null;

  // Sold-out bank / exhausted piece supply: never try (or trade toward) a
  // build we have no piece for. null (unknown) is treated as available.
  const devAvailable = opts.bankDevCards !== 0 && allowed("buy-dev");
  const pieces = opts.piecesLeft;
  const hasPiece = (item: "settlement" | "city" | "road"): boolean => {
    if (!pieces) return true;
    const left = item === "settlement" ? pieces.settlements : item === "city" ? pieces.cities : pieces.roads;
    return left === null || left > 0;
  };
  const canBuild = (item: keyof typeof COSTS): boolean =>
    item === "dev" ? devAvailable : hasPiece(item) && allowed(item === "city" ? "build-city" : item === "road" ? "build-road" : "build-settlement");

  const afford = (item: keyof typeof COSTS): boolean =>
    RESOURCES.every((r) => you.hand[r] >= ((COSTS[item][r] as number | undefined) ?? 0));

  const choices = planning.builds.filter((b) => canBuild(b.kind));
  const top = choices[0];
  const evaluation = { horizon: planning.horizon.turns, gap: planning.gap,
    alternatives: choices.slice(0, 8).map((b) => ({ kind: b.kind, score: b.score, wait: b.wait, vertexId: b.vertexId })) };
  const finish = (decision: AutopilotDecision): AutopilotDecision => ({ ...decision, evaluation });
  const build = (choice: BuildEvaluation): AutopilotDecision | null => {
    if (!affordableWithTrades(you.hand, you.bankRatio, choice.cost)) return null;
    const trade = tradeTowardCost(you.hand, you.bankRatio, choice.cost, planning.weights);
    if (trade && allowed("bank-trade")) return { kind: "bank-trade", trade,
      describe: `bank-trade ${trade.giveCount} ${trade.give} for ${trade.get} to fund ${choice.kind}` };
    if (trade) return null;
    if (choice.kind === "dev") return afford("dev") && allowed("buy-dev")
      ? { kind: "buy-dev", describe: "buy a development card — best progress within the remaining game" } : null;
    if (!gs || gs.youPlayer === null || !board) return null;
    const roads = choice.roadEdges?.filter((id) => !gs.state.roads.some((r) => r.edgeId === id)) ?? [];
    if (roads.length) {
      if (!allowed("build-road") || !hasPiece("road")) return null;
      const edge = board.edges[roads[0]];
      const coord = pixelsToColonistEdge(board.vertices[edge.a], board.vertices[edge.b]);
      return coord ? { kind: "build-road", coord, describe: `road for funded ${choice.kind === "road" ? "Longest Road" : "settlement claim"}` } : null;
    }
    if (choice.vertexId === undefined) return null;
    const v = board.vertices[choice.vertexId];
    const coord = pixelToColonistCorner(v.x, v.y);
    if (!coord) return null;
    const kind = choice.kind === "city" ? "build-city" : "build-settlement";
    return allowed(kind) ? { kind, coord, describe: `${choice.kind} — best progress within ~${planning.horizon.turns.toFixed(1)} turns` } : null;
  };

  // An available win outranks spending a development card or a speculative trade.
  for (const choice of choices.filter((b) => b.kind !== "dev" && b.vp >= planning.gap && b.wait === 0)) {
    const action = build(choice);
    if (action) return finish(action);
  }

  if (knightReason) return finish({ kind: "play-knight", describe: `play a knight — ${knightReason}` });

  if (opts.hasMonopoly && allowed("play-monopoly")) {
    const opponents = [...tracker.players.values()].filter((p) => p.name !== youName);
    const scoreHand = (hand: Record<Resource, number>, horizon = planning.horizon): number =>
      evaluateBuilds(planning.options, hand, planning.production, you.bankRatio, planning.remaining, planning.gap, horizon)[0]?.score ?? 0;
    const base = scoreHand(you.hand);
    const futureHand = Object.fromEntries(RESOURCES.map((r) => [r, you.hand[r] + planning.production[r]])) as Record<Resource, number>;
    const laterHorizon = { ...planning.horizon, turns: Math.max(0, planning.horizon.turns - 1) };
    const futureBase = scoreHand(futureHand, laterHorizon);
    let best: { resource: Resource; value: number; haul: number } | null = null;
    let waitingValue = 0;
    for (const resource of RESOURCES) {
      const haul = confirmedMonopolyHaul(tracker.players.values(), youName, resource);
      const next = { ...you.hand, [resource]: you.hand[resource] + haul };
      let delay = 0;
      let futureHaul = 0;
      for (const opponent of opponents) {
        const input = planning.inputs.find((p) => p.name === opponent.name);
        if (!input) continue;
        const goal = planning.victories.find((p) => p.name === opponent.name)?.steps[0]?.cost ?? BUILD_COSTS.city;
        const rate = Object.fromEntries(RESOURCES.map((r) => [r, input.production[r] * (input.rollsPerTurn ?? 2)])) as Record<Resource, number>;
        const before = turnsToAfford(goal, opponent.hand, rate, opponent.bankRatio);
        const after = turnsToAfford(goal, { ...opponent.hand, [resource]: 0 }, rate, opponent.bankRatio);
        delay += Math.max(0, Math.min(planning.horizon.turns + 1, after) - Math.min(planning.horizon.turns + 1, before));
        const expected = Object.fromEntries(RESOURCES.map((r) => [r, opponent.hand[r] + rate[r]])) as Record<Resource, number>;
        // Expected next-turn spending consumes the very pile we might wait for.
        const spends = affordableWithTrades(expected, opponent.bankRatio, goal);
        futureHaul += Math.max(0, expected[resource] - (spends ? goal[resource] ?? 0 : 0));
      }
      const value = scoreHand(next) - base + delay / (1 + planning.horizon.turns);
      const survival = planning.horizon.turns / (1 + planning.horizon.turns);
      const later = scoreHand({ ...futureHand, [resource]: futureHand[resource] + futureHaul }, laterHorizon) - futureBase;
      waitingValue = Math.max(waitingValue, survival * Math.max(0, later));
      if (haul > 0 && (!best || value > best.value)) best = { resource, value, haul };
    }
    if (best && best.value > 0 && best.value + 1e-6 >= waitingValue) return finish({
      kind: "play-monopoly", resource: best.resource,
      describe: `play monopoly on ${best.resource} — ${best.haul} confirmed cards, more useful now than waiting`,
    });
  }

  if (top && opts.hasYearOfPlenty && allowed("play-year-of-plenty")) {
    let best: { resources: [Resource, Resource]; improvement: number } | null = null;
    for (const a of RESOURCES) for (const b of RESOURCES) {
      const hand = { ...you.hand }; hand[a]++; hand[b]++;
      const after = evaluateBuilds([top], hand, planning.production, you.bankRatio, planning.remaining, planning.gap, planning.horizon)[0];
      if (after.wait < top.wait && (!best || after.score - top.score > best.improvement)) best = { resources: [a, b], improvement: after.score - top.score };
    }
    if (best && best.improvement > 0) return finish({ kind: "play-year-of-plenty", resources: best.resources,
      describe: `year of plenty — ${best.resources.join(" + ")} accelerates ${top.kind}` });
  }
  if (opts.hasRoadBuilding && allowed("play-road-building") && hasPiece("road")) {
    const free = freeRoadChoices(Math.min(2, pieces?.roads ?? 2))[0];
    if (free && free.score > (top?.score ?? 0) && free.wait < planning.horizon.turns) {
      return finish({ kind: "play-road-building", describe: `free roads accelerate the planned ${free.kind}` });
    }
  }
  if (top) {
    const action = build(top);
    if (action) return finish(action);
    // Commit affordable road stages only when the complete investment fits
    // inside the race. This preserves the chosen budget while avoiding a
    // giant hand held until a multi-road settlement is fully funded.
    if (top.roadEdges?.length && top.wait < planning.horizon.turns && afford("road") &&
        allowed("build-road") && hasPiece("road") && gs && board) {
      const edge = board.edges[top.roadEdges[0]];
      const coord = pixelsToColonistEdge(board.vertices[edge.a], board.vertices[edge.b]);
      if (coord) return finish({ kind: "build-road", coord,
        describe: `road toward planned ${top.kind}, completable within the remaining game` });
    }
    // Save for the best investment. Partial trades must improve its completion
    // time and preserve the resources already reserved for it.
    if (allowed("bank-trade")) {
      const trade = tradeTowardCost(you.hand, you.bankRatio, top.cost, planning.weights);
      if (trade) {
        const hand = { ...you.hand }; hand[trade.give] -= trade.giveCount; hand[trade.get]++;
        const after = turnsToAfford(top.cost, hand, planning.production, you.bankRatio);
        if (after + 1e-6 < top.wait || (handSize > limit && RESOURCES.reduce((s, r) => s + hand[r], 0) < handSize)) return finish({ kind: "bank-trade", trade,
          describe: `bank-trade ${trade.giveCount} ${trade.give} for ${trade.get} to reach ${top.kind} sooner` });
      }
    }
  }
  if (opts.canProposeTrade && top && allowed("propose-trade")) {
    const offer = proposeTrade(you.hand, [top.cost], planning.weights, { alreadyAsked: opts.askedThisTurn, handLimit: limit });
    if (offer) return finish({ kind: "propose-trade", offer, describe: "offer a trade toward the planned build" });
  }
  return allowed("end-turn") ? finish({ kind: "end-turn", describe: top ? `save for ${top.kind} (~${top.wait.toFixed(1)} turns)` : "end turn — no verified build target" }) : null;
}

export interface AutopilotView {
  enabled: boolean;
  status: Record<ActionKind, boolean>;
  note: string;
}

/**
 * The executor: watches turn state, decides via decideNext, sends learned
 * frames, and requires each action to be CONFIRMED by the game (log/board
 * event) before the next.
 *
 * Handles rolls, the strategy build order, robber placement, forced discards
 * (choosing the worst cards itself), and ending the turn. Trades stay manual
 * (the overlay advises).
 */
export class Autopilot {
  enabled = false;
  wsTurnSeen = false;
  robberPending = false;
  discardPending = false;
  private myTurn = false;
  /** the two independent turn signals; myTurn is their OR */
  private wsMine = false;
  private domMine = false;
  private rolledThisTurn = false;
  /** dev-card rules: one play per turn, none the turn it was bought */
  private devPlayedThisTurn = false;
  private devsBoughtThisTurn = 0;
  /** free roads still owed after playing Road Building */
  private freeRoads = 0;
  /** trade offer ids we've already answered this game */
  private answeredOffers = new Set<string>();
  /** resources we've asked for in proposals this turn (max 2 proposals) */
  private askedThisTurn: Resource[] = [];
  private lastAsked: Resource | null = null;
  private pending: { kind: ActionKind; t: number; via: "ws" | "dom"; label?: string } | null =
    null;
  /** DOM controls (per action) we clicked but the game never confirmed. */
  private domFailed = new Map<DomActionKind, Set<string>>();
  private note = "off";
  /** Hold time for the game's first settlement placement (think it through). */
  private firstSettHold: number | null = null;

  constructor(
    private learner: ProtocolLearner,
    /**
     * Send the decision as real colonist WebSocket action frames. Returns true
     * if it was dispatched (channel known + action resolvable). This is the
     * primary path now that the outbound protocol is reverse-engineered.
     */
    private dispatch: (decision: AutopilotDecision) => boolean = () => false,
    private domAct: (kind: DomActionKind, exclude?: ReadonlySet<string>) => string | null = (
      kind,
      exclude,
    ) => tryDomAction(kind, document, exclude),
    private domDiscard: (cards: Partial<Record<Resource, number>>) => string | null = tryDomDiscard,
  ) {}

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.note = on ? "on — waiting for your turn" : "off";
    if (!on) {
      this.pending = null;
      this.firstSettHold = null;
    }
  }

  onTurnState(currentColor: number, myColor: number | null): void {
    this.wsTurnSeen = true;
    this.wsMine = myColor !== null && currentColor === myColor;
    this.recomputeTurn();
  }

  /**
   * DOM turn signal from colonist's "Your Turn" banner. Runs EVERY tick, not
   * only as a WS fallback: colonist's turn-state color ids don't always line
   * up with our detected `myColor` (or myColor may never arrive), and when
   * they don't, the WS signal alone would leave autopilot thinking it's never
   * our turn. The banner is authoritative for the local player — colonist only
   * shows it to you on your own turn — so we OR it with the WS signal.
   */
  noteDomTurn(mine: boolean): void {
    this.domMine = mine;
    this.recomputeTurn();
  }

  /** Fold the WS and DOM turn signals; reset per-turn state on the rising edge. */
  private recomputeTurn(): void {
    const mine = this.wsMine || this.domMine;
    if (mine && !this.myTurn) {
      // fresh turn: roll again, replay dev/knight limits, retry every control
      this.rolledThisTurn = false;
      this.devPlayedThisTurn = false;
      this.devsBoughtThisTurn = 0;
      this.freeRoads = 0;
      this.askedThisTurn = [];
      this.domFailed.clear();
    }
    if (!mine && this.myTurn && this.pending?.kind === "end-turn") this.pending = null;
    this.myTurn = mine;
  }

  onYouRolled(): void {
    this.rolledThisTurn = true;
    if (this.pending?.kind === "roll") this.pending = null;
  }

  onConfirm(kind: ActionKind): void {
    if (this.pending?.kind === kind) this.pending = null;
    if (kind === "move-robber") this.robberPending = false;
    if (kind === "discard") this.discardPending = false;
    if (
      kind === "play-knight" ||
      kind === "play-monopoly" ||
      kind === "play-road-building" ||
      kind === "play-year-of-plenty"
    ) {
      this.devPlayedThisTurn = true;
    }
    if (kind === "play-road-building") this.freeRoads = 2; // the game now owes us two roads
    if (kind === "propose-trade" && this.lastAsked) this.askedThisTurn.push(this.lastAsked);
    if (kind === "build-road" && this.freeRoads > 0) this.freeRoads--;
    if (kind === "buy-dev") this.devsBoughtThisTurn++;
  }

  /** A non-knight dev card was played manually (YoP, Monopoly, Road Building). */
  markDevPlayed(): void {
    this.devPlayedThisTurn = true;
  }

  /** A 7 was rolled or a knight played — the current player must move the robber. */
  setRobberPending(pending: boolean): void {
    this.robberPending = pending;
  }

  /** The game is asking for discards (a 7 while someone is over the limit). */
  setDiscardPending(pending: boolean): void {
    this.discardPending = pending;
  }

  view(): AutopilotView {
    return { enabled: this.enabled, status: this.learner.status(), note: this.note };
  }

  tick(ctx: {
    tracker: TrackerState | null;
    gs: { state: GameState; youPlayer: PlayerId | null } | null;
    advice: PlacementAdvice | null;
    fit: LiveStrategyFit | null;
    robberHex?: { x: number; y: number } | null;
    /** knight cards visible in your hand (DOM count; includes unplayable new buys) */
    knightsInHand?: number;
    /** dev cards left in the bank (0 = sold out) */
    bankDevCards?: number | null;
    /** building pieces left in our supply (0 = can't build that piece) */
    piecesLeft?: { settlements: number | null; cities: number | null; roads: number | null };
    /** dev-card type ids we hold (13 = monopoly) */
    myDevCardIds?: number[];
    /** friendly robber: whether a given player may be robbed (>= 3 VP) */
    canRob?: (player: PlayerId) => boolean;
    /** other players' trade offers awaiting our answer (any turn) */
    tradeOffers?: TradeOffer[];
    /** victory points to win for this game */
    winTarget?: number;
    /** our cheapest next VP step (from the win-chance model) */
    endgameStep?: "city" | "settlement" | "dev" | "road";
  planning?: PlanningContext;
    /** number of players at the table (player trading needs 3+) */
    playerCount?: number;
    now?: number;
  }): void {
    const vpCardsHeld = (ctx.myDevCardIds ?? []).filter((id) => id === 12).length;
    if (!this.enabled) return;
    const now = ctx.now ?? Date.now();

    // Player-trade offers are answered on ANY turn, ahead of everything else:
    // an unanswered offer holds the table on our timer. Each offer is answered
    // once (colonist closes it or records our response).
    const you0 = ctx.tracker?.youName ? ctx.tracker.players.get(ctx.tracker.youName) : undefined;
    for (const offer of ctx.tradeOffers ?? []) {
      if (this.answeredOffers.has(offer.id) || !you0) continue;
      const plan = ctx.planning?.builds.map((b) => b.cost) ?? planCosts(ctx.fit, visibleVp(you0), ctx.winTarget ?? 10);
      const verdict = decideTradeResponse(you0.hand, offer, plan, ctx.tracker?.discardLimit ?? 7);
      const decision: AutopilotDecision = {
        kind: "trade-response",
        tradeId: offer.id,
        accept: verdict.accept,
        describe: `${verdict.accept ? "accept" : "decline"} trade — ${verdict.reason}`,
      };
      this.answeredOffers.add(offer.id);
      if (this.answeredOffers.size > 200) this.answeredOffers.clear();
      if (this.dispatch(decision)) {
        this.note = `acting: ${decision.describe}`;
        return;
      }
      this.note = `▶ ${decision.describe} (answer it manually — response frame not learned yet)`;
    }

    if (this.pending) {
      if (now - this.pending.t > 8000) {
        // Learn from the mistake: the action produced nothing.
        if (this.pending.via === "ws") {
          // wrong template — discard and re-learn from the next manual use
          this.learner.discard(this.pending.kind);
          this.note = `"${this.pending.kind}" wasn't confirmed — template discarded, do it manually once to re-learn`;
        } else {
          // Wrong control — remember it so the retry clicks the next candidate.
          if (this.pending.label && this.pending.kind !== "discard") {
            const kind = this.pending.kind as DomActionKind;
            const failed = this.domFailed.get(kind) ?? new Set<string>();
            failed.add(this.pending.label);
            this.domFailed.set(kind, failed);
          }
          this.note = `clicked "${this.pending.label ?? this.pending.kind}" but the game didn't react — trying another control`;
        }
        this.pending = null;
      }
      return;
    }
    // The robber is only ever yours to move on your own turn. In DOM-fallback
    // sessions the "Your Turn" banner is REPLACED by the robber banner, so
    // pending alone must open the gate there; with WS turn state captured the
    // turn must agree, so a stray banner match can never act out of turn.
    const robberMine = this.robberPending && (this.myTurn || !this.wsTurnSeen);
    // A discard is NOT turn-bound: anyone over the limit discards on a 7. The
    // over-the-limit hand check keeps stray banner matches from acting.
    const you = ctx.tracker?.youName ? ctx.tracker.players.get(ctx.tracker.youName) : undefined;
    const mustDiscard =
      this.discardPending && !!you && handTotal(you) > (ctx.tracker?.discardLimit ?? 9);
    if (!robberMine && !mustDiscard && (!this.myTurn || !ctx.tracker || !ctx.tracker.youName)) {
      // Surface which turn signals are firing so a detection gap is diagnosable.
      const sig = this.domMine ? "banner" : this.wsMine ? "ws" : "none";
      this.note = `on — waiting for your turn (signal: ${sig})`;
      return;
    }
    if (!ctx.tracker || !ctx.tracker.youName) return;

    const decision = decideNext({
      tracker: ctx.tracker,
      youName: ctx.tracker.youName,
      fit: ctx.fit,
      gs: ctx.gs,
      advice: ctx.advice,
      rolledThisTurn: this.rolledThisTurn,
      robberPending: robberMine,
      robberHex: ctx.robberHex,
      discardPending: mustDiscard,
      // Knights held (dev-card id 11, from ground-truth state) beyond any dev
      // bought this turn (a fresh buy can't be played), and no dev played yet.
      knightAvailable:
        !this.devPlayedThisTurn &&
        ((ctx.myDevCardIds ?? []).filter((id) => id === 11).length ||
          (ctx.knightsInHand ?? 0)) > this.devsBoughtThisTurn,
      bankDevCards: ctx.bankDevCards,
      piecesLeft: ctx.piecesLeft,
      // Playable only if we hold the card, haven't played a dev this turn, and
      // hold more than we bought this turn (a fresh buy can't be played).
      // 13 = monopoly, 14 = road building, 15 = year of plenty.
      hasMonopoly:
        !this.devPlayedThisTurn &&
        (ctx.myDevCardIds ?? []).filter((id) => id === 13).length > this.devsBoughtThisTurn,
      hasRoadBuilding:
        !this.devPlayedThisTurn &&
        (ctx.myDevCardIds ?? []).filter((id) => id === 14).length > this.devsBoughtThisTurn,
      hasYearOfPlenty:
        !this.devPlayedThisTurn &&
        (ctx.myDevCardIds ?? []).filter((id) => id === 15).length > this.devsBoughtThisTurn,
      freeRoadsPending: this.freeRoads,
      canRob: ctx.canRob,
      winTarget: ctx.winTarget,
      endgameStep: ctx.endgameStep,
      planning: ctx.planning,
      vpCardsHeld,
      canProposeTrade: (ctx.playerCount ?? 2) >= 3 && this.askedThisTurn.length < 2,
      askedThisTurn: this.askedThisTurn,
    });
    if (decision?.kind === "propose-trade" && decision.offer) {
      this.lastAsked = (Object.keys(decision.offer.wanted) as Resource[])[0] ?? null;
    }
    if (!decision) {
      this.note = robberMine
        ? "on — move the robber manually (board not captured or no good tile)"
        : "on — nothing to do";
      return;
    }

    // The game's FIRST settlement is the single most consequential move of the
    // game — hold it for at least 30s so placement analysis settles before
    // committing (and the human can veto). One-shot: once elapsed it places.
    if (decision.kind === "build-settlement" && (ctx.gs?.state.buildings.length ?? 1) === 0) {
      if (this.firstSettHold === null) {
        this.firstSettHold = now + FIRST_SETTLEMENT_THINK_MS;
        this.note = "thinking about the best opening spot…";
        return;
      }
      if (now < this.firstSettHold) {
        this.note = `thinking about the best opening spot… (${Math.ceil((this.firstSettHold - now) / 1000)}s)`;
        return;
      }
      this.firstSettHold = null;
    }

    if (decision.kind === "play-monopoly" && (!decision.resource ||
      confirmedMonopolyHaul(ctx.tracker.players.values(), ctx.tracker.youName, decision.resource) <= 0)) {
      this.note = "holding Monopoly — resource holdings are not confirmed";
      return;
    }
    // Preferred: dispatch real colonist WebSocket action frames (rolls, builds,
    // robber, end turn) — reverse-engineered from the protocol, works for
    // placements too.
    if (this.dispatch(decision)) {
      this.pending = { kind: decision.kind, t: now, via: "ws" };
      this.note = `acting: ${decision.describe}`;
      return;
    }
    // Zero-setup fallback: click the game's own button for non-spatial acts.
    if (decision.kind === "roll" || decision.kind === "end-turn" || decision.kind === "buy-dev") {
      const clicked = this.domAct(decision.kind, this.domFailed.get(decision.kind));
      if (clicked) {
        this.pending = { kind: decision.kind, t: now, via: "dom", label: clicked };
        this.note = `acting: ${decision.describe} (clicked game button)`;
        return;
      }
    }
    // Zero-setup fallback: pick the cards in the game's own discard dialog.
    if (decision.kind === "discard" && decision.cards) {
      const clicked = this.domDiscard(decision.cards);
      if (clicked) {
        this.pending = { kind: "discard", t: now, via: "dom" };
        this.note = `acting: ${decision.describe} (clicked the discard dialog)`;
        return;
      }
    }
    // Board placements (settlement/road/city/robber) can't be automated: they
    // need a click on colonist's canvas board, which has no clickable DOM, and
    // the outbound action format isn't reconstructable from the socket. Point
    // the human at the exact spot instead.
    const spatial =
      decision.kind === "build-settlement" ||
      decision.kind === "build-road" ||
      decision.kind === "build-city" ||
      decision.kind === "move-robber";
    this.note = spatial
      ? `▶ Your click: ${decision.describe} — highlighted ① on the map above (board clicks aren't automated)`
      : decision.kind === "discard"
        ? `on — pick the discards manually once (${decision.describe}) so I can learn it`
        : decision.kind === "play-knight"
          ? `on — play a knight manually once so I can learn it (${decision.describe})`
          : decision.kind === "play-road-building" || decision.kind === "play-year-of-plenty"
            ? `on — ${decision.describe} (couldn't send it — play the card manually)`
            : `on — "${decision.kind}" not learned yet, do it manually once`;
  }
}
