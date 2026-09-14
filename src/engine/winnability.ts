import { RESOURCES, Resource } from "./types";
import { turnsToAfford } from "./horizon";

/**
 * Bounded resource-specific completion planner. Candidate portfolios respect
 * pieces, legal expansion routes and bonus ownership; successive investments
 * add production as they are financed. A softmax compares the resulting times
 * as a heuristic race estimate, not a calibrated probability or exact solver.
 * No route found means unverified, not proof that victory is impossible.
 */

export type Hand = Record<Resource, number>;
export type Cost = Partial<Record<Resource, number>>;

export const BUILD: Record<"city" | "settlement" | "road" | "dev", Cost> = {
  city: { ore: 3, wheat: 2 },
  settlement: { wood: 1, brick: 1, sheep: 1, wheat: 1 },
  road: { wood: 1, brick: 1 },
  dev: { ore: 1, sheep: 1, wheat: 1 },
};

/** Base-game odds a bought dev card is a Victory Point card (5 of 25). */
const VP_CARD_RATE = 5 / 25;
/** Longest Road / Largest Army each award this many points. */
const BONUS_VP = 2;
/** softmax spread (turns) — larger = flatter probabilities. */
const TAU = 2.0;

export interface PlayerVictoryInput {
  name: string;
  playerId?: number;
  isYou: boolean;
  /** public victory points (buildings + any bonus they already hold) */
  publicVp: number;
  /**
   * Victory points NOT on the board: our own VP dev cards (exact), or an
   * opponent's expected VP cards from their unplayed dev cards (estimate).
   * Counted toward the target; games are won at 10-14 public VP this way.
   */
  hiddenVp?: number;
  settlementsLeft: number | null;
  citiesLeft: number | null;
  roadsLeft: number | null;
  /** their settlements on the board (upgrade targets for cities) */
  settlementsOnBoard: number;
  /** a legal settlement spot reachable now (else the next one needs a road) */
  settlementSpotOpen: boolean;
  knightsPlayed: number;
  /** their current longest continuous road (segments) */
  longestRoadLen: number;
  hand: Hand;
  /** expected cards per roll, per resource */
  production: Hand;
  cityProduction?: Hand[];
  bankRatios?: Cost;
  rollsPerTurn?: number;
  holdsLargestArmy?: boolean;
  holdsLongestRoad?: boolean;
  knightsInHand?: number;
  playableKnights?: number;
  /** Verified board routes; an empty array means no accessible sites. */
  settlementRoutes?: Array<{ vertexId: number; edges: number[]; conflicts: number[]; production?: Hand }>;
  /** Verified extension, null means no route found by the bounded search. */
  longestRoadPath?: number[] | null;
}

export interface WinContext {
  /** victory points needed to win (colonist: 10, some modes 15) */
  target: number;
  /** dev cards left in the bank (null = unknown → treat as plentiful) */
  devDeckLeft: number | null;
}

export type VictoryStepKind = "city" | "settlement" | "largest-army" | "longest-road" | "vp-dev";

export interface VictoryStep {
  kind: VictoryStepKind;
  vp: number;
  cost: Cost;
  note: string;
  delay?: number;
  production?: Hand;
  vertexId?: number;
  roadEdges?: number[];
}

export interface VictoryPlan {
  name: string;
  isYou: boolean;
  publicVp: number;
  target: number;
  /** No feasible completion portfolio was found within the bounded search. */
  eliminated: boolean;
  steps: VictoryStep[];
  planVp: number;
  /** resources still to acquire for the plan (plan cost minus hand) */
  need: Cost;
  turnsToWin: number;
  /** Legacy relative ranking weight, NOT a calibrated win probability. */
  winProb: number;
  largestArmyReachable: boolean;
  longestRoadReachable: boolean;
  summary: string;
}

function costCards(c: Cost): number {
  return RESOURCES.reduce((s, r) => s + (c[r] ?? 0), 0);
}
function addCost(a: Cost, b: Cost): Cost {
  const out: Cost = { ...a };
  for (const r of RESOURCES) if (b[r]) out[r] = (out[r] ?? 0) + (b[r] ?? 0);
  return out;
}
function scaleCost(c: Cost, k: number): Cost {
  const out: Cost = {};
  for (const r of RESOURCES) if (c[r]) out[r] = (c[r] ?? 0) * k;
  return out;
}

/** A single VP "buy" available to a player. */
interface Buy extends VictoryStep { conflicts?: number[]; requiresSettlement?: number; }

/** Enumerate every VP source still open to a player, cheapest-first per unit. */
function buysFor(p: PlayerVictoryInput, ctx: WinContext, holdsLA: boolean, holdsLR: boolean, laReach: boolean, lrReach: boolean, knightsToLA: number, roadsToLR: number): Buy[] {
  const buys: Buy[] = [];

  // Cities: upgrade an existing settlement. Bounded by BOTH the pieces in
  // supply and the settlements actually on the board.
  const cityN = Math.min(p.citiesLeft ?? Infinity, p.settlementsOnBoard);
  for (let i = 0; i < cityN; i++) {
    buys.push({ kind: "city", vp: 1, cost: BUILD.city, note: "upgrade a settlement to a city",
      production: p.cityProduction?.[i] ?? Object.fromEntries(RESOURCES.map((r) => [r,
        p.production[r] / Math.max(1, p.settlementsOnBoard + 2 * (4 - (p.citiesLeft ?? 4)))])) as Hand });
  }

  // Settlements: the first is free of roads if a spot is open now; each further
  // one assumes a road to open a new corner.
  const settN = p.settlementsLeft ?? 0;
  const freeSpots = p.settlementSpotOpen ? 1 : 0;
  const routes = p.settlementRoutes?.slice().sort((a, b) => a.edges.length - b.edges.length);
  for (let i = 0; i < (routes?.length ?? settN); i++) {
    const route = routes?.[i];
    const roads = route ? route.edges.length : i >= freeSpots ? 1 : 0;
    if (roads > (p.roadsLeft ?? 0)) continue;
    buys.push({ kind: "settlement", vp: 1,
      cost: addCost(BUILD.settlement, scaleCost(BUILD.road, roads)),
      note: roads ? `${roads} road${roads === 1 ? "" : "s"} + settlement` : "settlement on an open spot",
      production: route?.production, vertexId: route?.vertexId, roadEdges: route?.edges, conflicts: route?.conflicts });
    if (route && (p.citiesLeft ?? 0) > 0) buys.push({ kind: "city", vp: 1,
      cost: BUILD.city, note: "upgrade the planned settlement to a city",
      production: route.production, vertexId: route.vertexId, requiresSettlement: route.vertexId });
  }

  // Largest Army (+2): only if we can still take it and the deck can supply it.
  if (!holdsLA && laReach) {
    buys.push({
      kind: "largest-army",
      vp: BONUS_VP,
      cost: scaleCost(BUILD.dev, Math.max(0, knightsToLA - (p.knightsInHand ?? 0)) / (14 / 25)),
      delay: Math.max(0, knightsToLA - ((p.playableKnights ?? 0) > 0 ? 1 : 0)),
      note: `${knightsToLA} more knight${knightsToLA > 1 ? "s" : ""} for Largest Army`,
    });
  }

  // Longest Road (+2): only if roads remain and we can beat the holder.
  if (!holdsLR && lrReach) {
    buys.push({
      kind: "longest-road",
      vp: BONUS_VP,
      cost: scaleCost(BUILD.road, roadsToLR),
      roadEdges: p.longestRoadPath ?? undefined,
      note: `${roadsToLR} more road${roadsToLR > 1 ? "s" : ""} for Longest Road`,
    });
  }

  // Victory-Point dev cards: slow filler while the deck has cards. Expected
  // dev cards per VP = 1 / rate; capped by what the deck can plausibly give.
  const perVp = Math.round(1 / VP_CARD_RATE);
  const vpDevCap = ctx.devDeckLeft === null ? 6 : Math.floor((ctx.devDeckLeft * VP_CARD_RATE) + 0.001);
  for (let i = 0; i < vpDevCap; i++) {
    buys.push({ kind: "vp-dev", vp: 1, cost: scaleCost(BUILD.dev, perVp), note: "victory-point dev card (expected)" });
  }

  return buys;
}

/**
 * Choose the subset of buys with the LOWEST TOTAL card cost that reaches `gap`
 * VP. A 0/1 knapsack (each city/settlement/bonus is one item) — greedy by
 * cost-per-VP would wrongly spend 9 cards on a +2 bonus to close a 1-VP gap a
 * 5-card city closes. gap ≤ target and the item pool is tiny, so this is cheap.
 */
function cheapestPlan(buys: Buy[], gap: number, player: PlayerVictoryInput): Buy[] {
  if (gap <= 0) return [];
  type Candidate = { items: Buy[]; cost: Cost; time: number; roads: number; settlements: number; cities: number };
  const rate = Object.fromEntries(RESOURCES.map((r) => [r, player.production[r] * (player.rollsPerTurn ?? 2)])) as Hand;
  const dp: Candidate[][] = Array.from({ length: Math.ceil(gap) + 1 }, () => []);
  dp[0] = [{ items: [], cost: {}, time: 0, roads: 0, settlements: 0, cities: 0 }];
  for (const b of buys) {
    for (let v = dp.length - 2; v >= 0; v--) {
      for (const c of [...dp[v]]) {
        if (b.requiresSettlement !== undefined && !c.items.some((x) => x.kind === "settlement" && x.vertexId === b.requiresSettlement)) continue;
        if (b.kind === "settlement" && b.vertexId !== undefined && c.items.some((x) => x.vertexId === b.vertexId || x.conflicts?.includes(b.vertexId!))) continue;
        const cities = c.cities + (b.kind === "city" ? 1 : 0);
        if (cities > (player.citiesLeft ?? 0)) continue;
        const settlements = c.settlements + (b.kind === "settlement" ? 1 : 0);
        // Existing city upgrades return settlement pieces before expansion.
        if (settlements - c.cities > (player.settlementsLeft ?? 0)) continue;
        const edges = new Set(c.items.flatMap((x) => x.roadEdges ?? []));
        const extraRoads = b.roadEdges ? b.roadEdges.filter((id) => !edges.has(id)).length :
          b.kind === "longest-road" ? b.cost.wood ?? 0 : b.kind === "settlement" ? (b.cost.wood ?? 1) - 1 : 0;
        const roads = c.roads + extraRoads;
        if (roads > (player.roadsLeft ?? 0)) continue;
        const cost = addCost(c.cost, b.cost);
        const shared = (b.roadEdges?.length ?? extraRoads) - extraRoads;
        if (shared > 0) { cost.wood = (cost.wood ?? 0) - shared; cost.brick = (cost.brick ?? 0) - shared; }
        const delay = Math.max(b.delay ?? 0, ...c.items.map((x) => x.delay ?? 0));
        const time = turnsToAfford(cost, player.hand, rate, player.bankRatios) + delay;
        const nv = Math.min(dp.length - 1, v + b.vp);
        dp[nv].push({ items: [...c.items, b], cost, time, roads, settlements, cities });
      }
      // Keep several different resource/route portfolios, not just cheapest cards.
      for (let n = v + 1; n < dp.length; n++) {
        dp[n].sort((a, b) => a.time - b.time || costCards(a.cost) - costCards(b.cost));
        dp[n] = dp[n].slice(0, 24);
      }
    }
  }
  return dp[dp.length - 1].sort((a, b) => sequenceTime(a.items, player) - sequenceTime(b.items, player))[0]?.items ?? [];
}

/** Finance successive builds, adding their production as soon as built.
 * This avoids projecting an entire game's costs at the opening economy. */
export function sequenceTime(steps: VictoryStep[], p: PlayerVictoryInput): number {
  const hand = { ...p.hand };
  const rolls = p.rollsPerTurn ?? 2;
  const rate = Object.fromEntries(RESOURCES.map((r) => [r, p.production[r] * rolls])) as Hand;
  const usedRoads = new Set<number>();
  let elapsed = 0;
  for (const step of steps) {
    const cost = { ...step.cost };
    for (const id of step.roadEdges ?? []) {
      if (usedRoads.has(id)) { cost.wood = (cost.wood ?? 0) - 1; cost.brick = (cost.brick ?? 0) - 1; }
      usedRoads.add(id);
    }
    const wait = turnsToAfford(cost, hand, rate, p.bankRatios);
    if (!Number.isFinite(wait)) return Infinity;
    elapsed += wait;
    let missing = 0;
    for (const r of RESOURCES) {
      hand[r] += rate[r] * wait - (cost[r] ?? 0);
      if (hand[r] < -1e-9) { const bought = Math.ceil(-hand[r] - 1e-9); missing += bought; hand[r] += bought; }
    }
    for (const r of [...RESOURCES].sort((a, b) => (p.bankRatios?.[a] ?? 4) - (p.bankRatios?.[b] ?? 4))) {
      const take = Math.min(Math.ceil(missing - 1e-9), Math.floor((hand[r] + 1e-9) / (p.bankRatios?.[r] ?? 4)));
      hand[r] -= take * (p.bankRatios?.[r] ?? 4); missing -= take;
    }
    for (const r of RESOURCES) rate[r] += (step.production?.[r] ?? 0) * rolls;
  }
  return elapsed + Math.max(0, ...steps.map((s) => s.delay ?? 0));
}

function summarise(p: PlayerVictoryInput, plan: VictoryStep[], eliminated: boolean, laReach: boolean, lrReach: boolean): string {
  if (p.publicVp <= 0 && plan.length === 0 && eliminated) return "not in the game yet";
  if (eliminated) return "no verified path to the target with the available pieces and routes";
  if (plan.length === 0) return "already at the target";
  const counts = new Map<VictoryStepKind, number>();
  for (const s of plan) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  const label: Record<VictoryStepKind, [string, string]> = {
    city: ["city", "cities"],
    settlement: ["settlement", "settlements"],
    "largest-army": ["Largest Army", "Largest Army"],
    "longest-road": ["Longest Road", "Longest Road"],
    "vp-dev": ["VP dev card", "VP dev cards"],
  };
  const parts: string[] = [];
  for (const [kind, n] of counts) parts.push(`${n} ${n > 1 ? label[kind][1] : label[kind][0]}`);
  let s = parts.join(" + ");
  if ((p.hiddenVp ?? 0) > 0) s = `(+${p.isYou ? "" : "~"}${Number((p.hiddenVp ?? 0).toFixed(1))} hidden) ` + s;
  // Call out a blocked natural path so the "why" is explicit.
  if ((p.citiesLeft ?? 1) === 0 && p.settlementsOnBoard > 0) s += " (no cities left)";
  if (!laReach && !lrReach && (p.roadsLeft ?? 1) === 0) s += "; roads spent";
  return s;
}

/**
 * Analyse the whole table at once (needed to know who holds Largest Army /
 * Longest Road) and return each player's plan with a normalised win chance.
 */
export function analyzeVictory(players: PlayerVictoryInput[], ctx: WinContext): VictoryPlan[] {
  const maxKnights = Math.max(0, ...players.map((p) => p.knightsPlayed));
  const knightLeaders = players.filter((p) => p.knightsPlayed === maxKnights && maxKnights >= 3);
  const maxRoad = Math.max(0, ...players.map((p) => p.longestRoadLen));
  const roadLeaders = players.filter((p) => p.longestRoadLen === maxRoad && maxRoad >= 5);

  const plans: VictoryPlan[] = players.map((p) => {
    const holdsLA = p.holdsLargestArmy ?? (knightLeaders.length === 1 && knightLeaders[0].name === p.name);
    const holdsLR = p.holdsLongestRoad ?? (roadLeaders.length === 1 && roadLeaders[0].name === p.name);

    // knights needed to seize Largest Army: beat the leader, or reach the
    // minimum of 3 if nobody holds it yet.
    const knightsToLA = holdsLA ? 0 : Math.max(3, maxKnights + 1) - p.knightsPlayed;
    const laReach =
      !holdsLA && knightsToLA >= 1 && (ctx.devDeckLeft === null || ctx.devDeckLeft + (p.knightsInHand ?? 0) >= knightsToLA);
    const roadsToLR = holdsLR ? 0 : p.longestRoadPath === null ? Infinity : p.longestRoadPath?.length ?? Math.max(5, maxRoad + 1) - p.longestRoadLen;
    const lrReach = !holdsLR && roadsToLR >= 1 && (p.roadsLeft ?? 0) >= roadsToLR;

    const gap = Math.ceil(ctx.target - p.publicVp - (p.hiddenVp ?? 0));
    const buys = buysFor(p, ctx, holdsLA, holdsLR, laReach, lrReach, knightsToLA, roadsToLR);
    const maxAttainable = buys.reduce((s, b) => s + b.vp, 0);
    let eliminated = gap > 0 && maxAttainable < gap;
    const won = gap <= 0;

    const chosen = won ? [] : cheapestPlan(buys, gap, p);
    if (!won && chosen.length === 0) eliminated = true;
    const steps: VictoryStep[] = chosen.map((b) => ({ kind: b.kind, vp: b.vp, cost: b.cost, note: b.note, delay: b.delay, production: b.production, vertexId: b.vertexId, roadEdges: b.roadEdges }));
    const planVp = steps.reduce((s, b) => s + b.vp, 0);

    const fundedRoads = new Set<number>();
    const totalCost = steps.reduce<Cost>((acc, s) => {
      const next = addCost(acc, s.cost);
      for (const id of s.roadEdges ?? []) {
        if (fundedRoads.has(id)) { next.wood = (next.wood ?? 0) - 1; next.brick = (next.brick ?? 0) - 1; }
        fundedRoads.add(id);
      }
      return next;
    }, {});
    const need: Cost = {};
    for (const r of RESOURCES) {
      const n = (totalCost[r] ?? 0) - p.hand[r];
      if (n > 0) need[r] = n;
    }

    const turnsToWin = won ? 0 : eliminated ? Infinity : sequenceTime(steps, p);

    return {
      name: p.name,
      isYou: p.isYou,
      publicVp: p.publicVp,
      target: ctx.target,
      eliminated,
      steps,
      planVp,
      need,
      turnsToWin,
      winProb: 0,
      largestArmyReachable: laReach,
      longestRoadReachable: lrReach,
      summary: summarise(p, steps, eliminated, laReach, lrReach),
    };
  });

  // Normalise turns → probabilities via softmax over -turns. A player already
  // at the target dominates; eliminated players get zero.
  const live = plans.filter((p) => !p.eliminated && Number.isFinite(p.turnsToWin));
  const tmin = Math.min(...live.map((p) => p.turnsToWin), Infinity);
  let wsum = 0;
  const weights = plans.map((p) => {
    if (p.eliminated || !Number.isFinite(p.turnsToWin)) return 0;
    const w = Math.exp(-(p.turnsToWin - tmin) / TAU);
    wsum += w;
    return w;
  });
  plans.forEach((p, i) => {
    p.winProb = wsum > 0 ? weights[i] / wsum : 0;
  });
  return plans.sort((a, b) => b.winProb - a.winProb);
}
