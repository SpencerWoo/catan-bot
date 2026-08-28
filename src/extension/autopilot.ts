import { GameState, PlayerId, RESOURCES, Resource, pips } from "../engine/types";
import { vertexPips } from "../engine/board";
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
import { PlacementAdvice, colonistIdForColor, spotContest } from "./placement";
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
}

/** The builds we're saving for, in order, as costs — the plan a trade must serve. */
export function planCosts(fit: LiveStrategyFit | null, vp: number, target = 10): Array<Partial<Record<Resource, number>>> {
  const order: Array<keyof typeof BUILD_COSTS> =
    vp < target - 2 ? ["settlement", "city"] : fit ? fit.strategy.buildOrder.filter((i) => i !== "road") : ["city", "settlement"];
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
        (starve && hex.kind === starve ? 1.4 : 1);
      if (b.player === youPlayer) mine += value;
      else opp += value;
    }
    const score = opp - mine * 1.5;
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

  // Opponent analysis: find the strongest opponent
  const opponents = [...tracker.players.values()].filter((p) => p.name !== youName);
  const mainOpponent = opponents.reduce((a, b) => visibleVp(b) > visibleVp(a) ? b : a, opponents[0]);
  
  // Infer opponent's hidden dev cards
  const oppDevInference = mainOpponent 
    ? inferOpponentDevCards(mainOpponent, robberHex ?? null, tracker, board, gs?.state.buildings ?? null)
    : { likelyMonopoly: false, likelyKnight: false, likelyRoadBuilding: false, likelyYearOfPlenty: false, likelyVpCard: false, unplayedCount: 0, confidence: 0, reasoning: [] };
  
  // Win probability estimation
  const winProb = mainOpponent && board
    ? estimateWinProbability(you, mainOpponent, tracker, board, robberHex ?? null, gs?.state.buildings ?? null)
    : { probability: 0.5, factors: { vpDelta: 0, productionDelta: 0, devCardThreat: 0, resourceRisk: 0, hasLargestArmy: false, hasLongestRoad: false }, reasoning: [] };
  // Risk profile by game distance: far behind -> lotto (buy variance),
  // comfortably ahead -> protect (shed variance before 7s eat the lead).
  const riskMode = riskModeOf(winProb.probability);
  // Opponent weakness: their thinnest produced resource (robber starvation).
  const starveResource = ((): Resource | null => {
    if (!board || !mainOpponent || gs?.youPlayer === null || gs === null) return null;
    const oppId = mainOpponent.playerId ?? colonistIdForColor(mainOpponent.color);
    if (oppId === null) return null;
    return opponentStarveResource(gs.state, oppId as PlayerId);
  })();
  
  // Balanced-dice shoe: conditional P(next roll = n) from the counted deck
  // drives robber targeting (block the number likeliest to roll) and the
  // 7-risk timing of anti-discard trading.
  const deck = deckStatus(tracker);
  const probOf = (n: number): number => deck.prob.get(n) ?? pips(n) / 36;
  const base7 = 6 / 36;
  const p7next = probOf(7);

  // Forced discard (a 7 while over the limit) resolves before anything else:
  // pick the worst cards ourselves instead of letting the game choose.
  if (discardPending && handSize > limit) {
    const cards = planDiscard(you.hand, Math.floor(handSize / 2), fit);
    return {
      kind: "discard",
      cards,
      describe: `discard ${describeCards(cards)} (keeping the next build)`,
    };
  }

  // Robber placement takes priority: it blocks everything until resolved.
  if (robberPending && gs && gs.youPlayer !== null && board) {
    const target = bestRobberHex(gs.state, gs.youPlayer, robberHex ?? null, opts.canRob, probOf, starveResource);
    if (target) {
      return {
        kind: "move-robber",
        coord: { x: target.hex.x, y: target.hex.y },
        describe: target.describe,
      };
    }
    return null; // no useful tile — let the human decide
  }

  // Road Building placement: a played card owes the game free roads — it
  // blocks everything else until they're placed. Follow the advised expansion
  // path first; otherwise extend toward the best reachable corner.
  if ((opts.freeRoadsPending ?? 0) > 0 && board && gs && gs.youPlayer !== null) {
    const advised = (advice?.roadEdges ?? []).find(
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

    // Check if an opponent is currently blocked by the robber
    const opponentBlocked =
      !!robberHex &&
      !!gs &&
      !!board &&
      gs.state.buildings.some(
        (b) =>
          b.player !== gs.youPlayer &&
          board.vertices[b.vertexId].hexIds.some(
            (h) => board.hexes[h].q === robberHex.x && board.hexes[h].r === robberHex.y,
          ),
      );

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

    // Don't waste a knight if an opponent is already blocked — save it for when you're blocked
    if (opponentBlocked && !blockedMine) return null;

    // Aggressive LA chase: 3+ held dev cards almost certainly include knights
    // (deck is 14 knights / 21 total). Play them every turn to build the
    // army — you need 3 separate turns to play them all, so delay wastes
    // the LA timeline. Only hoard when you have 1-2 left (robber utility).
    const unplayedDev = you.devCards - you.knightsPlayed;
    if (unplayedDev >= 3) return "3+ held dev cards — play knights to chase Largest Army";

    // Largest Army logic: only chase it if it's DECISIVE for the win.
    // 1. You need it to win (close to 10 VP, +2 from LA would win).
    // 2. You must PREVENT opponent from winning with it (they're close to 10 and have/near LA).
    // Otherwise, save the knight for robber utility (block the leader).
    const myKnights = you.knightsPlayed;
    const myVp = visibleVp(you);
    const oppMaxKnights = Math.max(
      0,
      ...[...tracker.players.values()].filter((p) => p.name !== youName).map((p) => p.knightsPlayed),
    );
    const oppMaxVp = Math.max(
      0,
      ...[...tracker.players.values()].filter((p) => p.name !== youName).map((p) => visibleVp(p)),
    );

    const youHoldLA = myKnights >= 3 && myKnights > oppMaxKnights;
    const oppHoldsLA = oppMaxKnights >= 3 && oppMaxKnights > myKnights;
    const youNearWin = myVp >= 8; // LA (+2) would reach 10
    const oppNearWin = oppMaxVp >= 8;

    // Chase LA only if: you need it to win, or must stop opponent from winning with it.
    const needLAForWin = youNearWin && !youHoldLA && myKnights >= 2;
    const mustBlockOppLA = oppNearWin && (oppHoldsLA || oppMaxKnights >= 2) && myKnights < oppMaxKnights + 1;

    if (needLAForWin) return "Largest Army would win the game";
    if (mustBlockOppLA) return "must take Largest Army to stop opponent winning with it";

    // Not decisive for LA — save knight for robber utility (handled by robber placement logic).
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

  // After rolling (we were over the limit, or it only became worth it now).
  if (knightReason) {
    return { kind: "play-knight", describe: `play a knight — ${knightReason}` };
  }

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
    item === "dev" ? devAvailable : hasPiece(item);

  const afford = (item: keyof typeof COSTS): boolean =>
    RESOURCES.every((r) => you.hand[r] >= ((COSTS[item][r] as number | undefined) ?? 0));

  // Monopoly: play it for maximum HAUL — steal the resource opponents hold the
  // MOST of (estimated from their production mix × their total cards), breaking
  // ties toward a resource our next build needs. Only when opponents are
  // card-rich enough that a monopoly is worth spending on.
  if (opts.hasMonopoly && allowed("play-monopoly")) {
    const opponents = [...tracker.players.values()].filter((p) => p.name !== youName);
    const oppCards = opponents.reduce((s, p) => s + (p.serverCards ?? handTotal(p)), 0);
    
    // Use dev card inference: if opponent likely has monopoly, we should be more
    // careful about holding large single-resource piles, and we should play our
    // monopoly to steal their most concentrated resource.
    const mainOpp = opponents.reduce((a, b) => (b.serverCards ?? handTotal(b)) > (a.serverCards ?? handTotal(a)) ? b : a, opponents[0]);
    const oppDevInference = mainOpp
      ? inferOpponentDevCards(mainOpp, robberHex ?? null, tracker, board, gs?.state.buildings ?? null)
      : { likelyMonopoly: false, likelyKnight: false, likelyRoadBuilding: false, likelyYearOfPlenty: false, likelyVpCard: false, unplayedCount: 0, confidence: 0, reasoning: [] };
    
    if (oppCards >= 5) {
      // Estimated opponent holdings of each resource: production-mix share of
      // their card total. Resources they pump out and don't spend pile up.
      const prodByRes = Object.fromEntries(RESOURCES.map((r) => [r, 0])) as Record<Resource, number>;
      for (const p of opponents) {
        const prod = expectedProduction(p);
        for (const r of RESOURCES) prodByRes[r] += prod[r];
      }
      const totalProd = RESOURCES.reduce((s, r) => s + prodByRes[r], 0);
      // production-mix share of their cards; if we haven't learned their income
      // yet, assume an even spread so a card-rich opponent still triggers it.
      const estHeld = (r: Resource) =>
        totalProd > 0 ? (prodByRes[r] / totalProd) * oppCards : oppCards / RESOURCES.length;

      // do we need this resource for our next build? (tiebreaker)
      const shortForBuild = (r: Resource) =>
        fit.strategy.buildOrder.some((item) => (BUILD_COSTS[item][r] ?? 0) > you.hand[r]);

      // If opponent likely has monopoly, prioritize stealing the resource we have
      // the most of that they also likely have (prevent them from monopolizing us)
      const weHaveLots = RESOURCES.filter(r => you.hand[r] >= 4);
      let bestRes: Resource | null = null;
      let bestScore = 0;
      for (const r of RESOURCES) {
        let score = estHeld(r) + (shortForBuild(r) ? 0.75 : 0);
        // If we have 4+ of this and opponent likely has monopoly, STEAL IT FIRST
        if (weHaveLots.includes(r) && oppDevInference.likelyMonopoly) score += 2;
        if (score > bestScore) {
          bestScore = score;
          bestRes = r;
        }
      }
      // only worth it if the expected haul is meaningful (~2+ cards) — but
      // when the win-probability estimate says we're clearly BEHIND, gamble
      // on a smaller haul: waiting compounds the deficit.
      const haulFloor = winProb.probability < 0.4 ? 1.5 : 2;
      if (bestRes && estHeld(bestRes) >= haulFloor) {
        return {
          kind: "play-monopoly",
          resource: bestRes,
          describe: `play monopoly on ${bestRes} (~${estHeld(bestRes).toFixed(0)} cards from opponents)${weHaveLots.includes(bestRes) && oppDevInference.likelyMonopoly ? " [counter their monopoly]" : ""}`,
        };
      }
    }
  }

  // Road eagerness guard (per play feedback): don't build a speculative road
  // that just telegraphs a spot the opponent then takes. Roads are only built
  // (or funded) as part of a CLAIM: the advised road path (1–2 edges) ends at
  // a legal settlement corner, and roads + settlement are paid for together so
  // the spot is taken the SAME turn it's opened, before the opponent moves.
  const rawSpot =
    gs && gs.youPlayer !== null ? bestPlaceableNow(gs.state, gs.youPlayer) : null;
  // Weak-spot guard (batch 3: a 2-pip settlement was built for a 3:1 port —
  // 4 cards + roads for almost no production). Below 4 pips a corner is only
  // worth settling for a 2:1 port, or in the endgame where any VP counts.
  const spotOnNetwork = ((): number | null => {
    if (rawSpot === null || !board) return rawSpot;
    const v = board.vertices[rawSpot];
    const pipsHere = vertexPips(board, rawSpot);
    const endgame = visibleVp(you) + (opts.vpCardsHeld ?? 0) >= (opts.winTarget ?? 10) - 2;
    if (pipsHere >= 3 || endgame || (v.port && v.port.ratio === 2)) return rawSpot;
    return null;
  })();
  const ownSettlements =
    gs && gs.youPlayer !== null
      ? gs.state.buildings.filter((b) => b.player === gs.youPlayer && b.kind === "settlement").length
      : 0;
  const claim = ((): { roads: number; cost: Partial<Record<Resource, number>> } | null => {
    if (spotOnNetwork !== null) return null; // can settle without roads
    if (!advice || advice.roadEdges.length === 0 || !board || !gs || gs.youPlayer === null) return null;
    if (!hasPiece("settlement")) return null;
    const roads = advice.roadEdges.length; // the advised path is pre-trimmed to <= 2 edges
    const last = board.edges[advice.roadEdges[roads - 1]];
    // the path must actually reach a buildable corner within those edges
    if (!isVertexBuildable(gs.state, last.a) && !isVertexBuildable(gs.state, last.b)) return null;
    return { roads, cost: { wood: 1 + roads, brick: 1 + roads, sheep: 1, wheat: 1 } };
  })();
  const canClaimNow =
    !!claim && RESOURCES.every((r) => you.hand[r] >= (claim.cost[r] ?? 0));

  const buildDecision = (item: keyof typeof COSTS): AutopilotDecision | null => {
    if (item === "dev") {
      if (!devAvailable) return null;
      return { kind: "buy-dev", describe: "buy a development card" };
    }
    // No piece left in supply -> can't build it (5 settlements, 4 cities).
    if (!hasPiece(item)) return null;
    // Spatial builds need the captured board for coordinates.
    if (!gs || gs.youPlayer === null || !board) return null;
    if (item === "city") {
      const settlements = gs.state.buildings.filter(
        (b) => b.player === gs.youPlayer && b.kind === "settlement",
      );
      if (settlements.length === 0) return null;
      const target = settlements.reduce((a, b) =>
        vertexPips(board, a.vertexId) >= vertexPips(board, b.vertexId) ? a : b,
      );
      const v = board.vertices[target.vertexId];
      const coord = pixelToColonistCorner(v.x, v.y);
      if (coord) return { kind: "build-city", coord, describe: "upgrade best settlement to a city" };
    } else if (item === "settlement") {
      const spot = bestPlaceableNow(gs.state, gs.youPlayer);
      if (spot === null) return null;
      const v = board.vertices[spot];
      const coord = pixelToColonistCorner(v.x, v.y);
      if (coord) return { kind: "build-settlement", coord, describe: "settlement on your network" };
    } else if (item === "road") {
      if (!advice || advice.roadEdges.length === 0) return null;
      const e = board.edges[advice.roadEdges[0]];
      if (gs.state.roads.some((r) => r.edgeId === e.id)) return null; // stale advice
      const coord = pixelsToColonistEdge(board.vertices[e.a], board.vertices[e.b]);
      if (!coord) return null;
      // 1. A fully-funded claim: roads + settlement land this turn.
      if (claim && canClaimNow) {
        return {
          kind: "build-road",
          coord,
          describe: `road toward spot ① (${claim.roads} road${claim.roads > 1 ? "s" : ""}, settling it this turn)`,
        };
      }
      // 2. A development road. Game-log fix: a whole game with 0 roads built
      //    while wood+brick were discarded to 7s three times — spot ① was
      //    more than two roads away, so a same-turn claim was never possible
      //    and expansion simply froze. When the spot can't be claimed this
      //    turn anyway there is nothing to telegraph: extend toward it while
      //    keeping a road's worth for the claim, or whenever a 7 would
      //    otherwise take the cards.
      const nearLimit = handSize >= limit - 2;
      // keep a road's worth AND the settlement's own wood/brick (batch-1: four
      // roads in a row by minute 2.6 with no settlement until 4.6)
      const surplus = you.hand.wood >= 3 && you.hand.brick >= 3;
      const len = advice.roadPathLength ?? advice.roadEdges.length;
      // Road bloat guard (ranked 1v1 loss: 10 roads for 3 settlements): once we
      // have laid well more roads than buildings, stop speculative extension
      // unless a 7 is about to take the cards anyway.
      const myRoads = gs.state.roads.filter((r) => r.player === gs.youPlayer).length;
      const myBuildings = gs.state.buildings.filter((b) => b.player === gs.youPlayer).length;
      const bloated = myRoads >= myBuildings + 3;
      // absolute: the near-limit exception let a 2:1-ore-port hand lay 13 roads
      // for 3 buildings (batch 2) — surplus goes to trades/devs instead.
      // Exception: the win model says Longest Road is our cheapest +2.
      if (bloated && opts.endgameStep !== "road") return null;
      if (opts.endgameStep === "road" && afford("road")) {
        return { kind: "build-road", coord, describe: "road toward Longest Road (cheapest +2)" };
      }
      // with a claim in reach, prefer funding it (trade loop) over a lone road
      const claimStuck = !!claim && !affordableWithTrades(you.hand, you.bankRatio, claim.cost);
      // Race gate: if the closest opponent reaches spot ① as fast or faster,
      // a multi-road commitment is a donation (game-log loss: we fed 2 roads
      // into the middle while they connected first). Commit only when the
      // whole claim lands THIS turn; otherwise save the roads.
      const hasOpponent = gs.state.buildings.some((b) => b.player !== gs.youPlayer);
      let raceLost = false;
      let winningRace = false;
      if (gs.youPlayer !== null && len > 0 && hasOpponent) {
        const c = spotContest(gs.state, gs.youPlayer, advice.spots[0]?.vertexId ?? -1);
        if (c.oppLen === null) {
          winningRace = true; // opponents exist but none can reach the spot
        } else {
          // winning = a full road ahead; ties favor whoever moves next (them)
          winningRace = c.ourLen + 1 <= c.oppLen;
          if (!winningRace) {
            // only race-worthy if the whole claim (roads+settlement) lands now
            const finishNow = !!claim && affordableWithTrades(you.hand, you.bankRatio, claim.cost);
            raceLost = !finishNow;
          }
        }
      }
      // Winning the race outright makes plain-surplus extension safe (nothing
      // to telegraph); otherwise claims still demand 7-pressure discipline.
      const worthExtending =
        ((claim ? nearLimit && claimStuck : surplus || nearLimit) ||
          (winningRace && surplus)) &&
        !raceLost;
      if (hasPiece("settlement") && worthExtending) {
        return {
          kind: "build-road",
          coord,
          describe: `development road toward spot ① (${len} road${len > 1 ? "s" : ""} away)`,
        };
      }
      if (raceLost && hasPiece("settlement") && (surplus || nearLimit)) {
        return null; // explicitly hold: roads are not donations to a lost race
      }
    }
    return null;
  };

  // Growth phasing (from game-log analysis: a dev-card-first plan built 0 new
  // settlements and lost 35 pips to 63). EXPAND EARLY — settlements and cities
  // are the investment that pays off later — and only shift to a dev-card focus
  // once the economy is built (or expansion is exhausted). While growing, dev
  // cards are dropped from the plan so resources bank toward real production.
  const canExpandMore = (pieces?.settlements ?? 1) !== 0 || (pieces?.cities ?? 1) !== 0;
  // grow the board until we're within a couple points of winning, then let the
  // strategy (dev cards / army) close it out.
  // Grow until within 2 points of the TARGET (10-point game: 8; 15-point 1v1:
  // 13) — the old hard-coded 8 stopped expanding with 7 points still to go.
  const winTarget = opts.winTarget ?? 10;
  // our true score: public VP + the VP cards in hand (exact from card ids)
  const myVp = visibleVp(you) + (opts.vpCardsHeld ?? 0);
  // Lotto override: when we're far behind, dev cards ARE the comeback — each
  // one is a lottery ticket (VP card, knights -> army) — so they stay in the
  // plan even while the board is still small.
  const growthPhase = canExpandMore && myVp < winTarget - 2 && riskMode !== "lotto";
  // Post-growth (>= target-2, i.e. endgame): a settlement is a GUARANTEED point
  // for 4 cards while a dev card averages well under half a point (log game:
  // at 8 VP the bot sat on 11 cards buying dev cards and lost by one build).
  // Keep the strategy's order but never let "dev" outrank a settlement.
  const lateOrder = (bo: ReadonlyArray<keyof typeof COSTS>): ReadonlyArray<keyof typeof COSTS> => {
    const devAt = bo.indexOf("dev");
    if (devAt === -1 || bo.indexOf("settlement") < devAt) return bo;
    const rest: Array<keyof typeof COSTS> = bo.filter((x) => x !== "settlement");
    rest.splice(rest.indexOf("dev"), 0, "settlement");
    return rest;
  };
  const lateWithRoads = (bo: ReadonlyArray<keyof typeof COSTS>): ReadonlyArray<keyof typeof COSTS> => {
    let out: Array<keyof typeof COSTS> = bo.includes("road") ? [...bo] : [...bo, "road"]; // claim roads stay buildable late
    // and a dev card as the last resort: VP cards and knights (Largest Army)
    // close games — road-expand had no "dev" and held cards while behind
    if (!out.includes("dev")) out = [...out, "dev"];
    return out;
  };
  // City-vs-settlement (game-log fix: two losses sprawled to 3-5 settlements
  // with 0-1 cities while the winners made 3 cities). A city is the same +1 VP
  // as a settlement but DOUBLES an existing producer with no new road, spot,
  // or robber exposure — so upgrade before sprawling UNLESS a new settlement
  // spot clearly out-produces our best upgrade target (grab the great spot).
  const bestUpgradePips =
    gs && gs.youPlayer !== null && board
      ? gs.state.buildings
          .filter((b) => b.player === gs.youPlayer && b.kind === "settlement")
          .reduce((mx, b) => Math.max(mx, vertexPips(board, b.vertexId)), -1)
      : -1;
  const bestSpotPips = spotOnNetwork !== null && board ? vertexPips(board, spotOnNetwork) : -1;
  // upgrade first when we hold a settlement to convert and no clearly better
  // (2+ pips) new spot is sitting on our network
  const cityFirst = bestUpgradePips >= 0 && bestSpotPips < bestUpgradePips + 2;
  const growthOrder: ReadonlyArray<keyof typeof COSTS> = cityFirst
    ? ["city", "settlement", "road"]
    : ["settlement", "city", "road"];
  // Endgame steering: the win-chance model already knows our cheapest next VP
  // (city vs settlement vs dev/army vs longest road) — put it first so builds
  // AND trades pull toward it instead of the strategy's generic order.
  const steer = (bo: ReadonlyArray<keyof typeof COSTS>): ReadonlyArray<keyof typeof COSTS> =>
    opts.endgameStep ? [opts.endgameStep, ...bo.filter((x) => x !== opts.endgameStep)] : bo;
  const order: ReadonlyArray<keyof typeof COSTS> = growthPhase
    ? growthOrder // grow the board first; no dev-card buys
    : steer(lateWithRoads(lateOrder(fit.strategy.buildOrder)));

  // What would funding this build actually buy us? null = don't spend on it:
  // supply/bank exhausted, a settlement with no reachable spot, or a city
  // with nothing to upgrade. A settlement that needs the advised road(s)
  // first is funded at the full claim cost (roads + settlement together).
  // A road needs a valid advised edge to build.
  const fundingTarget = (item: keyof typeof COSTS): Partial<Record<Resource, number>> | null => {
    if (!canBuild(item)) return null;
    // Spatial builds need the captured board to verify placement is possible.
    if (!gs || gs.youPlayer === null || !board) return null;
    if (item === "road" && (!advice || advice.roadEdges.length === 0)) return null;
    if (item === "settlement" && spotOnNetwork === null) {
      return claim ? claim.cost : null;
    }
    if (item === "city" && ownSettlements === 0) return null;
    return BUILD_COSTS[item];
  };

  // Road Building: two free roads. Play it whenever we have a road target at
  // all — a same-turn claim (best), or the advised development path toward
  // spot ① (the roads we'd otherwise pay 2 wood + 2 brick for). Player
  // feedback: holding it for a perfect claim meant it was never played; two
  // free roads toward the next spot are worth more early than late, and the
  // free-road placer already follows the path (or extends to the best corner).
  if (
    opts.hasRoadBuilding &&
    allowed("play-road-building") &&
    hasPiece("road") &&
    advice &&
    advice.roadEdges.length > 0
  ) {
    const why = claim
      ? `free road${claim.roads > 1 ? "s" : ""} to claim spot ①`
      : `free roads toward spot ① (${advice.roadPathLength ?? advice.roadEdges.length} away)`;
    return { kind: "play-road-building", describe: `play road building — ${why}` };
  }

  // Year of Plenty: take exactly the 1–2 cards that COMPLETE the first build
  // in the plan we can't yet afford. Never played into a build that can't be
  // placed, and held when nothing is within 2 cards of completion.
  if (opts.hasYearOfPlenty && allowed("play-year-of-plenty")) {
    for (const item of order) {
      if (item === "road") continue;
      const cost = fundingTarget(item);
      if (!cost) continue;
      const missing: Resource[] = [];
      for (const r of RESOURCES) {
        for (let i = you.hand[r]; i < (cost[r] ?? 0); i++) missing.push(r);
      }
      if (missing.length === 0) continue;
      // Endgame (within 3 of the target): never hold YoP — take the two cards
      // the build is most short of even if it won't complete this turn (batch
      // 2: lost 13-11 with three dev cards unplayed). Otherwise only to finish.
      const endgame = myVp >= winTarget - 3;
      if (missing.length > 2 && !endgame) continue;
      if (missing.length > 2) missing.length = 2;
      while (missing.length < 2) {
        // second pick is a bonus: the strategy's most-valued resource
        missing.push([...RESOURCES].sort((a, b) => fit.strategy.weights[b] - fit.strategy.weights[a])[0]);
      }
      return {
        kind: "play-year-of-plenty",
        resources: [missing[0], missing[1]],
        describe: `play year of plenty — take ${missing.join(" + ")} to complete a ${item}`,
      };
    }
  }

  for (const item of order) {
    if (!afford(item)) continue;
    const d = buildDecision(item);
    if (d) return d;
  }

  // Growth-phase dev card. Growth excludes dev buys so resources bank toward
  // production, with three exceptions (batch-1 ranked analysis):
  //  (a) the robber is camping our tile and we hold no knight — a dev card is
  //      a 56% knight and the only way to move it (7-8 robs/game in losses);
  //  (b) NO settlement/city is reachable even with trades, so ore+sheep+wheat
  //      would just sit until a 7 halves it;
  //  (c) the hand is about to hit the limit and no trade toward a build exists.
  // Never while 2+ dev cards sit unplayed (15-dev-card spam in one loss), and
  // (c) runs AFTER the near-limit trades below so a reachable city wins.
  const robberOnMine =
    !!robberHex && !!gs && gs.youPlayer !== null && !!board &&
    gs.state.buildings.some(
      (b) => b.player === gs.youPlayer &&
        board.vertices[b.vertexId].hexIds.some((h) => board.hexes[h].q === robberHex.x && board.hexes[h].r === robberHex.y),
    );
  const devBuyOk = growthPhase && allowed("buy-dev") && devAvailable && afford("dev") && !!gs && gs.youPlayer !== null && you.devCards < 2;
  if (devBuyOk) {
    const targets = (["settlement", "city"] as const).map(fundingTarget).filter((c): c is NonNullable<typeof c> => !!c);
    const reachable = targets.some((c) => affordableWithTrades(you.hand, you.bankRatio, c));
    if (robberOnMine && !opts.knightAvailable) {
      return { kind: "buy-dev", describe: "buy a development card (robber on our tile, no knight in hand)" };
    }
    // Protect mode: when comfortably ahead we shed surplus toward the next
    // build (surplus-dump below) rather than swap 3 cards for a dev — the
    // dump runs at a 3-card buffer and never gives up the lead. A dev buy
    // here (b) would only be reachable-hiding; the dump handles the hand.
    if (!reachable && riskMode !== "protect") {
      return { kind: "buy-dev", describe: "buy a development card (nothing else reachable)" };
    }
  }

  // Hand-size pressure: at or over the discard limit, shed cards into any
  // affordable build rather than risk a 7 halving the hand. (>= so it acts
  // AT the limit, not only strictly over it.)
  if (handSize >= limit) {
    // a dev card is the LAST resort here: if a city/settlement is reachable
    // with trades, the trade loop below converts the surplus toward it instead
    const buildReachable =
      !!gs && gs.youPlayer !== null && // without the board, placeability is unknown — dump into a dev
      (["settlement", "city"] as const)
        .map(fundingTarget)
        .some((c) => !!c && affordableWithTrades(you.hand, you.bankRatio, c));
    for (const item of ["city", "settlement", "dev", "road"] as const) {
      if (item === "dev" && buildReachable) continue;
      if (!afford(item)) continue;
      const d = buildDecision(item);
      if (d) {
        return { ...d, describe: `${d.describe} (dumping cards — at the ${limit}-card limit)` };
      }
    }
  }

  // Propose a player trade first (cheaper than any bank trade): one surplus
  // card for the one card that completes the next build. Once per turn; the
  // bank loop below still runs next tick if nobody bites.
  if (opts.canProposeTrade && allowed("propose-trade")) {
    const plan = order.filter((i) => i !== "road").map(fundingTarget).filter((c): c is NonNullable<typeof c> => !!c);
    const prop = proposeTrade(you.hand, plan, fit.strategy.weights, { alreadyAsked: opts.askedThisTurn ?? [], handLimit: limit });
    if (prop) {
      return { kind: "propose-trade", offer: { offered: prop.offered, wanted: prop.wanted }, describe: `propose trade — ${prop.reason}` };
    }
  }

  // Proactive bank/port trading: trade toward the FIRST strategy build we can
  // COMPLETE with trades — at any hand size, not just when over the limit.
  // e.g. trade 4 wood for the wheat that finishes a city. Only surplus of the
  // least-valued resource is given, so we never trade away what the build needs.
  // Placement-gated (game-log fix: a whole city's worth of wheat/ore was
  // 4:1-traded toward settlements with no legal spot): a settlement with no
  // network spot is funded at the CLAIM cost (roads + settlement together) or
  // not at all, and a city needs a settlement to upgrade.
  for (const item of allowed("bank-trade") ? order : []) {
    if (item === "road") continue; // roads are only funded via a claim (above)
    const cost = fundingTarget(item);
    if (!cost) continue;
    const short = RESOURCES.some((r) => (cost[r] ?? 0) > you.hand[r]);
    if (!short) continue; // affordable as-is — the build loop handles it
    if (!affordableWithTrades(you.hand, you.bankRatio, cost)) continue;
    const trade = tradeTowardCost(you.hand, you.bankRatio, cost, fit.strategy.weights);
    if (trade) {
      return {
        kind: "bank-trade",
        trade,
        describe: `bank-trade ${trade.giveCount} ${trade.give} for ${trade.get} toward a ${item}`,
      };
    }
  }

  // Near/over the limit with no build completable THIS turn: still convert
  // surplus toward the next placeable build. Game-log fix (real 1v1 loss): a
  // 12-card wood/sheep pile with a city 4 cards away sat untouched — the loop
  // above only trades when it can finish the build — and was halved by 7s
  // three times. One 4:1 a turn toward the city beats losing 6 cards.
  // (needs the board: without it placeability is unknown, so no speculative trades)
  // In the endgame (within 2 of the target) holding cards has no future value:
  // trade toward the next VP step at ANY hand size (batch 4: lost at 13/15 with
  // 11 cards in hand).
  const endgameNow = myVp >= winTarget - 2;
  if ((endgameNow || handSize >= limit - 1) && allowed("bank-trade") && gs && gs.youPlayer !== null) {
    for (const item of order) {
      if (item === "road") continue;
      const cost = fundingTarget(item);
      if (!cost) continue;
      const trade = tradeTowardCost(you.hand, you.bankRatio, cost, fit.strategy.weights);
      // (batch 4: restricting 4:1s here cost tempo — 1-9 — so any trade that
      // moves the next build along is taken; the cards were buying speed)
      if (trade) {
        return {
          kind: "bank-trade",
          trade,
          describe: `bank-trade ${trade.giveCount} ${trade.give} for ${trade.get} toward a ${item} (near the ${limit}-card limit)`,
        };
      }
    }
  }

  // Near the discard limit with surplus: trade 4+ of one resource for what
  // the strategy needs most, to avoid losing cards to a 7. Triggers within
  // 2 cards of the limit — 3 when the balanced-dice shoe makes a 7
  // disproportionately likely next. Only if there's a buildable target in
  // the strategy order.
  const sevenDue = p7next >= base7 * 1.25;
  // Protect mode: when comfortably ahead, start shedding a full 3 cards
  // before the limit even without a due 7 — the lead is worth more than the
  // marginal cards, and a 7 must never be able to take it.
  const dumpDist = riskMode === "protect" ? 3 : sevenDue ? 3 : 2;
  if (handSize >= limit - dumpDist && allowed("bank-trade")) {
    const trade = tradeSurplusToAvoidDiscard(
      you.hand,
      you.bankRatio,
      fit.strategy.weights,
      limit,
      order,
      fundingTarget,
      dumpDist,
    );
    if (trade) {
      return {
        kind: "bank-trade",
        trade,
        describe: `bank-trade ${trade.giveCount} ${trade.give} for ${trade.get} (avoiding 7 discard — ${handSize}/${limit} cards)`,
      };
    }
  }

  // Monopoly defense: when the strongest opponent likely holds an unplayed
  // monopoly, any fat single-resource pile is bait — one card strips ALL of
  // it. Convert the pile into whatever the strategy needs next, even far below
  // the discard limit. Gated on inference confidence so weak guesses don't
  // trigger panic trades.
  if (
    oppDevInference.likelyMonopoly &&
    oppDevInference.confidence >= 0.5 &&
    handSize < limit - dumpDist &&
    allowed("bank-trade")
  ) {
    const fat = [...RESOURCES].sort((a, b) => you.hand[b] - you.hand[a])[0];
    if (you.hand[fat] >= 4) {
      const ratio = you.bankRatio[fat] ?? 4;
      // most-needed resource by strategy weight (same scoring as surplus dump)
      let need: Resource | null = null;
      let needScore = -Infinity;
      for (const r of RESOURCES) {
        const s = fit.strategy.weights[r] - you.hand[r] * 0.3;
        if (s > needScore) {
          needScore = s;
          need = r;
        }
      }
      if (need && need !== fat) {
        return {
          kind: "bank-trade",
          trade: { give: fat, get: need, giveCount: ratio },
          describe: `bank-trade ${ratio} ${fat} for ${need} (denying their likely monopoly)`,
        };
      }
    }
  }
  // (c) near the limit, nothing tradeable toward a build: a dev card beats a discard
  if (devBuyOk && handSize >= limit - 2) {
    return { kind: "buy-dev", describe: "buy a development card (hand near the limit, no trade toward a build)" };
  }

  // Last resort under hand pressure: no settlement/city was tradeable above and
  // the dev card isn't affordable either (batch 5: all cities, no spot, no
  // sheep -> 14 cards hoarded and discarded twice). Trade surplus toward a dev
  // card so knights/VP cards keep coming instead of feeding a 7.
  if (
    handSize >= limit && growthPhase && allowed("bank-trade") &&
    devAvailable && !afford("dev") && gs && gs.youPlayer !== null && you.devCards < 2 &&
    affordableWithTrades(you.hand, you.bankRatio, BUILD_COSTS.dev)
  ) {
    const trade = tradeTowardCost(you.hand, you.bankRatio, BUILD_COSTS.dev, fit.strategy.weights);
    if (trade) {
      return { kind: "bank-trade", trade, describe: `bank-trade ${trade.giveCount} ${trade.give} for ${trade.get} toward a dev card (nothing else reachable)` };
    }
  }

  // At/over the limit with no placeable target at all: dump the most
  // expendable surplus so a 7 doesn't take half of it.
  if (handSize >= limit && allowed("bank-trade")) {
    const trade = planBankTrade(you.hand, you.bankRatio, fit, canBuild);
    if (trade) {
      return {
        kind: "bank-trade",
        trade,
        describe: `bank-trade ${trade.giveCount} ${trade.give} for ${trade.get} (at the ${limit}-card limit)`,
      };
    }
  }

  return allowed("end-turn") ? { kind: "end-turn", describe: "end the turn" } : null;
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
      const plan = planCosts(ctx.fit, visibleVp(you0), ctx.winTarget ?? 10);
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
