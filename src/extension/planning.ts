import { opponentCutSites } from "./roadContest";
import { GameState, PlayerId, RESOURCES, pips } from "../engine/types";
import { isVertexBuildable, playerProduction } from "../engine/analysis";
import { analyzeVictory, BUILD, Cost, Hand, PlayerVictoryInput, VictoryPlan } from "../engine/winnability";
import { BuildEvaluation, BuildOption, evaluateBuilds, gameHorizon, Horizon, turnsToAfford } from "../engine/horizon";
import { roadPathTo, PlacementAdvice, describeVertex } from "./placement";
import { expectedProduction } from "./copilot";
import { TrackerState, visibleVp } from "./tracker";
import { discardIncome, expectedDiscardLoss } from "./discardRisk";
import { bonusTiming } from "../engine/bonusTiming";

export interface PlanningContext {
  horizon: Horizon;
  inputs: PlayerVictoryInput[];
  victories: VictoryPlan[];
  options: BuildOption[];
  builds: BuildEvaluation[];
  remaining: Cost;
  weights: Hand;
  production: Hand;
  gap: number;
}
export interface PlanningOptions {
  target?: number;
  robberHex?: { x: number; y: number } | null;
  devDeckLeft?: number | null;
  hiddenVp?: number;
  knightsInHand?: number;
  playableKnights?: number;
  pieces?: { settlements: number | null; cities: number | null; roads: number | null };
  /** Exact bridge inputs, when available. */
  inputs?: PlayerVictoryInput[];
}
export const zeroHand = (): Hand => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
export function planningAdvice(advice: PlacementAdvice, planning: PlanningContext, state: GameState): PlacementAdvice {
  if (advice.phase === "setup") return advice;
  const settlements = planning.builds.filter((b) => b.kind === "settlement" && b.vertexId !== undefined).slice(0, 3);
  const target = planning.builds[0]?.kind === "road" ? planning.builds[0] : settlements[0];
  return { ...advice, heading: "Expansion within the remaining game", spots: settlements.map((b, i) => ({
    vertexId: b.vertexId!, rank: i + 1, label: describeVertex(state, b.vertexId!) })),
    roadEdges: target?.roadEdges?.slice(0, 2) ?? [], roadPathLength: target?.roadEdges?.length ?? 0,
    note: target ? `~${planning.horizon.turns.toFixed(1)} turns of useful production remain in the race estimate.` : null,
    race: undefined };
}
export function vertexIncome(state: GameState, vertexId: number, rolls = 2): Hand {
  const result = zeroHand();
  for (const id of state.board.vertices[vertexId].hexIds) {
    const h = state.board.hexes[id];
    if (h.kind !== "desert") result[h.kind] += pips(h.token) / 36 * rolls;
  }
  return result;
}
export function settlementRoutes(state: GameState, player: PlayerId): NonNullable<PlayerVictoryInput["settlementRoutes"]> {
  const network = new Set(state.roads.filter((r) => r.player === player).flatMap((r) => [state.board.edges[r.edgeId].a, state.board.edges[r.edgeId].b]));
  return state.board.vertices.filter((v) => isVertexBuildable(state, v.id)).flatMap((v) => {
    const edges = roadPathTo(state, player, v.id);
    return edges.length || network.has(v.id) ? [{ vertexId: v.id, edges, conflicts: v.adjacent, production: vertexIncome(state, v.id, 1) }] : [];
  });
}

/** Exact longest trail over existing roads; stop at opponents' buildings. */
export function longestRoad(state: GameState, player: PlayerId): number {
  const edges = state.roads.filter((r) => r.player === player).map((r) => state.board.edges[r.edgeId]);
  const blocked = new Set(state.buildings.filter((b) => b.player !== player).map((b) => b.vertexId));
  const walk = (v: number, used: Set<number>): number => {
    if (used.size && blocked.has(v)) return used.size;
    let best = used.size;
    for (const edge of edges) if (!used.has(edge.id) && (edge.a === v || edge.b === v)) {
      used.add(edge.id);
      best = Math.max(best, walk(edge.a === v ? edge.b : edge.a, used));
      used.delete(edge.id);
    }
    return best;
  };
  return Math.max(0, ...[...new Set(edges.flatMap((e) => [e.a, e.b]))].map((v) => walk(v, new Set())));
}

/** Bounded route search, never treating road-piece count as a continuous road.
 * Search three additions ahead. Failure means unverified, not impossible. */
export function roadBonusPath(state: GameState, player: PlayerId, target: number, supply: number): number[] | null {
  let frontier: number[][] = [[]];
  const occupied = new Set(state.roads.map((r) => r.edgeId));
  const blocked = new Set(state.buildings.filter((b) => b.player !== player).map((b) => b.vertexId));
  for (let depth = 0; depth <= Math.min(3, supply); depth++) {
    const next: Array<{ path: number[]; length: number }> = [];
    const winners: Array<{ path: number[]; access: number; retained: number }> = [];
    for (const path of frontier) {
      const trial = { ...state, roads: [...state.roads, ...path.map((edgeId) => ({ edgeId, player }))] };
      const length = longestRoad(trial, player);
      if (length >= target) {
        // Among equally short bonus routes, prefer resistance to settlement cuts,
        // then useful settlement access.
        // Never spend an extra piece just to make an uncontested road longer.
        const access = settlementRoutes(trial, player)
          .filter(r => r.edges.length <= supply - path.length)
          .reduce((best, r) => Math.max(best,
            Object.values(r.production ?? {}).reduce((n, x) => n + x, 0) / (1 + r.edges.length)), 0);
        const retained = Math.min(length, ...opponentCutSites(trial, player).map(site =>
          longestRoad({ ...trial, buildings: [...trial.buildings, { ...site, kind: "settlement" }] }, player)));
        winners.push({ path, access, retained });
        continue;
      }
      const nodes = new Set(trial.roads.filter((r) => r.player === player).flatMap((r) => [state.board.edges[r.edgeId].a, state.board.edges[r.edgeId].b]));
      for (const b of state.buildings) if (b.player === player) nodes.add(b.vertexId);
      for (const edge of state.board.edges) if (!occupied.has(edge.id) && !path.includes(edge.id) &&
        ((nodes.has(edge.a) && !blocked.has(edge.a)) || (nodes.has(edge.b) && !blocked.has(edge.b)))) {
        next.push({ path: [...path, edge.id], length });
      }
    }
    if (winners.length) return winners.sort((a, b) => b.retained - a.retained || b.access - a.access)[0].path;
    const seen = new Set<string>();
    frontier = next.sort((a, b) => b.length - a.length).filter((x) => {
      const key = [...x.path].sort((a, b) => a - b).join(",");
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).slice(0, 32).map((x) => x.path);
  }
  return null;
}

/** Verify both the contender's extension and our cheapest retaining tie.
 * Unknown hands use a card-count upper bound, never invented exact resources.
 * Search remains bounded to three road placements on each side. */
export function roadDefensePath(state: GameState, players: PlayerVictoryInput[], target: number): number[] | null {
  const me = players.find(p => p.isYou);
  if (!me?.holdsLongestRoad || me.playerId === undefined || !me.roadsLeft) return null;
  let threatenedLength = me.longestRoadLen;
  for (const opponent of players) {
    if (opponent.isYou || opponent.playerId === undefined ||
      opponent.publicVp + (opponent.hiddenVp ?? 0) + 2 < target - 3) continue;
    const expected = Object.fromEntries(RESOURCES.map(r => [r,
      opponent.hand[r] + opponent.production[r] * (opponent.rollsPerTurn ?? players.length)])) as Hand;
    const ceiling = state.roads.filter(r => r.player === opponent.playerId).length + Math.min(3, opponent.roadsLeft ?? 0);
    // Joining two existing branches may add more than one length per new road.
    for (let length = ceiling; length > threatenedLength; length--) {
      if (length <= threatenedLength) continue;
      const path = roadBonusPath(state, opponent.playerId as PlayerId, length, opponent.roadsLeft ?? 0);
      if (!path?.length) continue;
      const free = (opponent.developmentCards ?? 0) > 0 ? 2 : 0;
      const paid = Math.max(0, path.length - free);
      const possible = opponent.handKnown !== false
        ? turnsToAfford({ wood: paid, brick: paid }, expected, zeroHand(), opponent.bankRatios) === 0
        : (opponent.resourceCardCount ?? 0) + RESOURCES.reduce((n, r) => n +
          opponent.production[r] * (opponent.rollsPerTurn ?? players.length), 0) >= paid * 2;
      if (possible) { threatenedLength = length; break; }
    }
  }
  return threatenedLength > me.longestRoadLen
    ? roadBonusPath(state, me.playerId as PlayerId, threatenedLength, me.roadsLeft) : null;
}

/** Award ties retain the current holder; a cut can leave the award unowned.
 * Only the completed legal build is credited, never a road-count estimate. */
function roadAwardSwing(state: GameState, players: PlayerVictoryInput[]) {
  const lengths = players.map(p => ({ p, length: longestRoad(state, p.playerId as PlayerId) }));
  const best = Math.max(5, ...lengths.map(x => x.length));
  const leaders = lengths.filter(x => x.length === best);
  const holder = players.find(p => p.holdsLongestRoad);
  const winner = leaders.find(x => x.p === holder)?.p ?? (leaders.length === 1 ? leaders[0].p : undefined);
  return { gained: winner?.isYou && !holder?.isYou ? 2 : 0,
    denied: holder && !holder.isYou && winner !== holder ? 2 : 0 };
}

/** Price the loss of a connected settlement opportunity against the opponent's
 * next best legal alternative. Do not count every adjacent site as a lost VP. */
function settlementDisruption(state: GameState, trial: GameState, vertexId: number,
  players: PlayerVictoryInput[], horizon: Horizon): number {
  let denied = 0;
  for (const p of players) {
    if (p.isYou || p.playerId === undefined || (p.settlementsLeft ?? 0) <= 0) continue;
    const before = p.settlementRoutes ?? settlementRoutes(state, p.playerId as PlayerId);
    if (!before.some(r => r.edges.length === 0 &&
      (r.vertexId === vertexId || state.board.vertices[vertexId].adjacent.includes(r.vertexId)))) continue;
    const production = Object.fromEntries(RESOURCES.map(r => [r, p.production[r] * (p.rollsPerTurn ?? players.length)])) as Hand;
    const value = (routes: typeof before) => evaluateBuilds(routes.filter(r => r.edges.length <= (p.roadsLeft ?? 0))
      .map(r => ({ kind: "settlement" as const, vp: 1,
        cost: { ...BUILD.settlement, wood: 1 + r.edges.length, brick: 1 + r.edges.length },
        production: vertexIncome(state, r.vertexId, p.rollsPerTurn ?? players.length) })),
      p.handKnown === false ? zeroHand() : p.hand, production, p.bankRatios ?? {}, BUILD.settlement, 2, horizon)[0]?.score ?? 0;
    // gap > 1 avoids treating an isolated denied settlement as an actual win.
    denied = Math.max(denied, value(before) - value(settlementRoutes(trial, p.playerId as PlayerId)));
  }
  return Math.max(0, denied) / Math.max(1, players.length - 1);
}

export function planPosition(tracker: TrackerState, youName: string,
  gs: { state: GameState; youPlayer: PlayerId | null } | null, opts: PlanningOptions = {}): PlanningContext {
  const target = opts.target ?? 10;
  const rolls = Math.max(2, tracker.players.size);
  const you = tracker.players.get(youName)!;
  const ids = [...tracker.players.keys()];
  const inputs: PlayerVictoryInput[] = opts.inputs ?? [...tracker.players.values()].map((p) => {
    // In 1v1 the other engine player is unambiguous. Live multiplayer passes
    // the bridge's roster mapping rather than guessing from color ids.
    const player = p.name === youName ? gs?.youPlayer : gs && gs.youPlayer !== null && tracker.players.size === 2 ?
      (gs.youPlayer === 0 ? 1 : 0) as PlayerId : ids.indexOf(p.name) as PlayerId;
    const own = !!gs && player !== null && player !== undefined ? gs.state.buildings.filter((b) => b.player === player) : [];
    const ownRoads = gs && player !== null && player !== undefined ? gs.state.roads.filter((r) => r.player === player).length : p.roads;
    const routes = gs && player !== null && player !== undefined ? settlementRoutes(gs.state, player) : undefined;
    return { name: p.name, playerId: player ?? undefined, isYou: p.name === youName, publicVp: visibleVp(p),
      hiddenVp: p.name === youName ? opts.hiddenVp ?? 0 : Math.min(5, p.devCards * 0.2),
      settlementsLeft: p.name === youName && opts.pieces ? opts.pieces.settlements : Math.max(0, 5 - p.settlements),
      citiesLeft: p.name === youName && opts.pieces ? opts.pieces.cities : Math.max(0, 4 - p.cities),
      roadsLeft: p.name === youName && opts.pieces ? opts.pieces.roads : Math.max(0, 15 - ownRoads),
      settlementsOnBoard: gs ? own.filter((b) => b.kind === "settlement").length : p.settlements,
      settlementSpotOpen: routes?.some((r) => r.edges.length === 0) ?? false,
      settlementRoutes: routes,
      knightsPlayed: p.knightsPlayed, knightsInHand: p.name === youName ? opts.knightsInHand : 0,
      playableKnights: p.name === youName ? opts.playableKnights : 0,
      longestRoadLen: gs && player !== null && player !== undefined ? longestRoad(gs.state, player) : 0,
      hand: p.hand, production: gs && player !== null && player !== undefined ? playerProduction(gs.state, player) : expectedProduction(p),
      cityProduction: gs ? own.filter((b) => b.kind === "settlement").map((b) => vertexIncome(gs.state, b.vertexId, 1)) : undefined,
      bankRatios: p.bankRatio, rollsPerTurn: rolls };
  });
  const mostKnights = Math.max(0, ...inputs.map((p) => p.knightsPlayed));
  const mostRoads = Math.max(0, ...inputs.map((p) => p.longestRoadLen));
  for (const p of inputs) {
    p.holdsLargestArmy ??= mostKnights >= 3 && p.knightsPlayed === mostKnights && inputs.filter((x) => x.knightsPlayed === mostKnights).length === 1;
    p.holdsLongestRoad ??= mostRoads >= 5 && p.longestRoadLen === mostRoads && inputs.filter((x) => x.longestRoadLen === mostRoads).length === 1;
  }
  for (const p of inputs) {
    const tracked = tracker.players.get(p.name);
    p.handKnown ??= tracked?.trackingHealth === "exact";
    p.resourceCardCount ??= tracked?.serverCards ?? RESOURCES.reduce((n, r) => n + p.hand[r], 0);
    p.developmentCards ??= tracked?.devCards ?? 0;
  }
  const victories = analyzeVictory(inputs, { target, devDeckLeft: opts.devDeckLeft ?? null });
  const horizon = gameHorizon(victories.map((v) => v.turnsToWin));
  const me = inputs.find((p) => p.isYou)!;
  const victory = victories.find((p) => p.isYou);
  const paidRoads = new Set<number>();
  const remaining = victory?.steps.reduce<Cost>((cost, step) => {
    for (const r of RESOURCES) cost[r] = (cost[r] ?? 0) + (step.cost[r] ?? 0);
    for (const id of step.roadEdges ?? []) {
      if (paidRoads.has(id)) { cost.wood = (cost.wood ?? 0) - 1; cost.brick = (cost.brick ?? 0) - 1; }
      paidRoads.add(id);
    }
    return cost;
  }, {}) ?? {};
  const production = Object.fromEntries(RESOURCES.map((r) => [r, me.production[r] * rolls])) as Hand;
  const gap = Math.max(0, target - me.publicVp - (me.hiddenVp ?? 0));
  const options: BuildOption[] = [];
  const roadReason = bonusTiming(inputs, victories, target, "longest-road");
  if (gs && gs.youPlayer !== null) {
    if ((me.citiesLeft ?? 0) > 0) for (const b of gs.state.buildings) if (b.player === gs.youPlayer && b.kind === "settlement") {
      options.push({ kind: "city", vp: 1, cost: BUILD.city, production: vertexIncome(gs.state, b.vertexId, rolls), vertexId: b.vertexId });
    }
    if ((me.settlementsLeft ?? 0) > 0) for (const route of me.settlementRoutes ?? settlementRoutes(gs.state, gs.youPlayer)) {
      if (route.edges.length > (me.roadsLeft ?? 0)) continue;
      const ratios = { ...you.bankRatio };
      const port = gs.state.board.vertices[route.vertexId].port;
      if (port) for (const r of RESOURCES) if (port.kind === "any" || port.kind === r) ratios[r] = Math.min(ratios[r] ?? 4, port.ratio);
      const trial: GameState = { ...gs.state,
        roads: [...gs.state.roads, ...route.edges.map(edgeId => ({ edgeId, player: gs.youPlayer! }))],
        buildings: [...gs.state.buildings, { vertexId: route.vertexId, player: gs.youPlayer, kind: "settlement" }] };
      const swing = roadAwardSwing(trial, inputs);
      options.push({ kind: "settlement", vp: 1 + swing.gained,
        deferredVp: roadReason ? 0 : swing.gained,
        disruptionValue: (roadReason?.startsWith("deny") ? swing.denied / Math.max(1, inputs.length - 1) : 0) +
          settlementDisruption(gs.state, trial, route.vertexId, inputs, horizon),
        cost: { wood: 1 + route.edges.length, brick: 1 + route.edges.length, wheat: 1, sheep: 1 },
        production: vertexIncome(gs.state, route.vertexId, rolls), vertexId: route.vertexId, roadEdges: route.edges, ratios });
    }
    const defense = roadDefensePath(gs.state, inputs, target);
    if (defense?.length) options.push({ kind: "road", vp: 0, protectsBonus: true,
      cost: { wood: defense.length, brick: defense.length }, production: zeroHand(), roadEdges: defense });
    // A reversible bonus transfer is not a permanent four-point gain.
    // Invest when needed for our finish or to stop theirs, not just because
    // an opponent currently holds the award.
    if (me.longestRoadPath?.length && roadReason) options.push({ kind: "road", vp: 2,
      disruptionValue: roadReason.startsWith("deny") ? 2 / Math.max(1, inputs.length - 1) : 0,
      deniesWin: roadReason.startsWith("deny"),
      cost: { wood: me.longestRoadPath.length, brick: me.longestRoadPath.length }, production: zeroHand(), roadEdges: me.longestRoadPath });
  }
  if (!gs && me.settlementsOnBoard > 0 && (me.citiesLeft ?? 0) > 0) {
    options.push({ kind: "city", cost: BUILD.city, vp: 1,
      production: Object.fromEntries(RESOURCES.map((r) => [r, production[r] / Math.max(1, me.settlementsOnBoard)])) as Hand });
  }
  if (opts.devDeckLeft !== 0) {
    const leader = Math.max(2, ...inputs.map((p) => p.knightsPlayed));
    const needed = Math.max(1, leader + 1 - me.knightsPlayed - (me.knightsInHand ?? 0));
    const armyValue = bonusTiming(inputs, victories, target, "largest-army")
      ? (14 / 25) * 2 / needed * horizon.turns / (horizon.turns + needed) : 0;
    const unblocking = zeroHand();
    if (opts.robberHex && gs && gs.youPlayer !== null && !opts.knightsInHand) {
      const hex = gs.state.board.hexes.find((h) => h.q === opts.robberHex!.x && h.r === opts.robberHex!.y);
      if (hex && hex.kind !== "desert") {
        const units = gs.state.buildings.filter((b) => b.player === gs.youPlayer && gs.state.board.vertices[b.vertexId].hexIds.includes(hex.id))
          .reduce((n, b) => n + (b.kind === "city" ? 2 : 1), 0);
        // A bought knight cannot be played until next turn; a natural seven
        // may clear the block first. Credit only that temporary recovery.
        const duration = Math.max(0, Math.min(horizon.turns, 3) - 1);
        unblocking[hex.kind] = pips(hex.token) / 36 * rolls * units * (14 / 25) * duration / Math.max(1, horizon.turns);
      }
    }
    options.push({ kind: "dev", cost: BUILD.dev, vp: 5 / 25 + armyValue, production: unblocking });
  }
  const builds = evaluateBuilds(options, you.hand, production, you.bankRatio, remaining, gap, horizon);
  // Charge the whole exposed hand, not only the delay to this build.
  // Immediate purchases are compared using their actual remaining hand by
  // the pilot, which also knows the allowed actions and trade sequence.
  const discardLoss = expectedDiscardLoss(tracker, you.hand, tracker.discardLimit,
    rolls, discardIncome(tracker, gs, opts.robberHex));
  for (const build of builds) if (build.wait > 0) build.score -= discardLoss / 4;
  builds.sort((a, b) => b.score - a.score || a.wait - b.wait);
  const reserve = builds[0]?.cost ?? remaining;
  const weights = Object.fromEntries(RESOURCES.map((r) => [r,
    1 + Math.max(0, (reserve[r] ?? 0) - you.hand[r]) / (1 + production[r] * horizon.turns)])) as Hand;
  return { horizon, inputs, victories, options, builds, remaining, weights, production, gap };
}
