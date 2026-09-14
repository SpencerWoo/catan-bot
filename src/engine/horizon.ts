import { RESOURCES, Resource } from "./types";
import type { Cost, Hand } from "./winnability";

/** Expected own turns to fund a cost, including resource-specific shortages
 * and trades of surplus only. Production is cards per OWN turn here. Future
 * income is an expectation; separate resource piles never pool trade fractions. */
export function turnsToAfford(cost: Cost, hand: Hand, production: Hand, ratios: Cost = {}): number {
  const covered = (turns: number): boolean => {
    let shortage = 0, exchange = 0;
    for (const r of RESOURCES) {
      const spare = hand[r] + production[r] * turns - (cost[r] ?? 0);
      if (spare < -1e-9) shortage += Math.ceil(-spare - 1e-9);
      else exchange += Math.floor((spare + 1e-9) / (ratios[r] ?? 4));
    }
    return exchange + 1e-9 >= shortage;
  };
  if (covered(0)) return 0;
  if (RESOURCES.every((r) => production[r] <= 0)) return Infinity;
  let hi = 1;
  while (hi < 4096 && !covered(hi)) hi *= 2;
  if (!covered(hi)) return Infinity;
  let lo = 0;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (covered(mid)) hi = mid; else lo = mid;
  }
  return hi;
}

export interface Horizon {
  /** Expected own turns before the first credible finish in the field. */
  turns: number;
  /** Continuous diagnostic only; no decisions branch on this value. */
  urgency: number;
}
export function gameHorizon(finishTimes: number[]): Horizon {
  const finite = finishTimes.filter((n) => Number.isFinite(n) && n >= 0);
  const turns = finite.length ? Math.min(...finite) : 24;
  return { turns, urgency: 1 / (1 + turns) };
}

export interface BuildOption {
  kind: "city" | "settlement" | "dev" | "road";
  cost: Cost;
  vp: number;
  production: Hand;
  vertexId?: number;
  roadEdges?: number[];
  ratios?: Cost;
  delay?: number;
  /** Taking this bonus delays the current holder's imminent finish. */
  deniesWin?: boolean;
}
export interface BuildEvaluation extends BuildOption {
  wait: number;
  score: number;
  productionValue: number;
}

/** Production only earns credit for useful income before the race ends.
 * Resources beyond the remaining plan are worth their bank conversion value.
 * Waiting is an explicit alternative: an unaffordable investment stays in the
 * same ranking as an affordable dev card, preventing spend-because-we-can. */
export function evaluateBuilds(options: BuildOption[], hand: Hand, production: Hand, ratios: Cost,
  remaining: Cost, gap: number, horizon: Horizon): BuildEvaluation[] {
  const resourceValue = (r: Resource): number => {
    const short = Math.max(0, (remaining[r] ?? 0) - hand[r]);
    const supplied = production[r] * horizon.turns;
    const usefulShare = short / Math.max(1, short + supplied);
    return usefulShare + (1 - usefulShare) / (ratios[r] ?? 4);
  };
  return options.map((option): BuildEvaluation => {
    const wait = turnsToAfford(option.cost, hand, production, ratios) + (option.delay ?? 0);
    const lifetime = Math.max(0, horizon.turns - wait);
    let productionValue = RESOURCES.reduce((s, r) => s + option.production[r] * lifetime * resourceValue(r), 0);
    if (option.ratios) for (const r of RESOURCES) {
      const surplus = Math.max(0, hand[r] + production[r] * lifetime - (remaining[r] ?? 0) - (option.cost[r] ?? 0));
      productionValue += surplus * Math.max(0, 1 / (option.ratios[r] ?? 4) - 1 / (ratios[r] ?? 4));
    }
    const points = Math.min(Math.max(0, gap), option.vp);
    const wins = option.kind !== "dev" && points >= gap && gap > 0;
    const discount = Number.isFinite(wait) ? Math.exp(-wait / (1 + horizon.turns)) / (1 + wait) : 0;
    // Four useful cards are roughly one build's worth of future progress.
    const score = (points + productionValue / 4) * discount + (wins && wait === 0 ? 100 : 0);
    return { ...option, wait, score, productionValue };
  }).sort((a, b) => b.score - a.score || a.wait - b.wait || a.kind.localeCompare(b.kind));
}
