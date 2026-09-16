import { turnsToAfford } from "./horizon";
import { BUILD, Hand, PlayerVictoryInput, sequenceTime, VictoryPlan } from "./winnability";
import { RESOURCES } from "./types";

/** Bonuses have a deadline, not an early-game progress reward. Keep them in
 * victory forecasts, but defer spending until waiting one more turn would
 * delay the finish. Denial is useful only against an imminent bonus holder. */
export function bonusTiming(players: PlayerVictoryInput[], plans: VictoryPlan[], target: number,
  kind: "largest-army" | "longest-road", playKnight = false): string | null {
  const me = players.find(p => p.isYou);
  if (!me) return null;
  const army = kind === "largest-army";
  const held = army ? "holdsLargestArmy" : "holdsLongestRoad";
  if (me[held]) {
    // Ties retain the holder. One knight now prevents a tied contender
    // overtaking on their next play; do not wait for the award to be lost.
    if (army && (me.playableKnights ?? 0) > 0 && players.some(p => !p.isYou &&
      p.knightsPlayed >= me.knightsPlayed && p.publicVp + (p.hiddenVp ?? 0) + 2 >= target - 3 &&
      (p.developmentCards === undefined || p.developmentCards > 0)))
      return "defend Largest Army against a late-game contender";
    return null;
  }
  const plan = plans.find(p => p.isYou);
  const count = army ? Math.max(3, 1 + Math.max(0, ...players.map(p => p.knightsPlayed))) - me.knightsPlayed
    : me.longestRoadPath?.length ?? Infinity;
  if (count <= 0 || !Number.isFinite(count) || (!army && count > (me.roadsLeft ?? 0))) return null;
  const rate = Object.fromEntries(RESOURCES.map(r => [r, me.production[r] * (me.rollsPerTurn ?? 2)])) as Hand;
  const purchases = army ? Math.max(0, count - (me.knightsInHand ?? 0)) / (14 / 25) : count;
  const unit = army ? BUILD.dev : BUILD.road;
  const cost = Object.fromEntries(RESOURCES.map(r => [r, (unit[r] ?? 0) * purchases]));
  const financing = turnsToAfford(cost, me.hand, rate, me.bankRatios);
  const plays = army ? Math.max(0, count - ((me.playableKnights ?? 0) > 0 ? 1 : 0)) : 0;
  const lead = playKnight ? plays : financing + plays;
  if (!Number.isFinite(lead)) return null;
  const label = army ? "Largest Army" : "Longest Road";
  // Taking the holder's two points must actually move their finish beyond
  // the next turn; a player who can win without them is not a denial target.
  const denial = players.some(p => !p.isYou && p[held] && plans.some(v => v.name === p.name &&
    v.turnsToWin <= 1 && p.publicVp + (p.hiddenVp ?? 0) - 2 + v.planVp < target));
  if (denial && financing + plays <= 1e-6) return `deny an imminent win by taking ${label}`;
  if (!plan?.steps.some(s => s.kind === kind)) return null;
  if (target - me.publicVp - (me.hiddenVp ?? 0) <= 2) return `prepare ${label} to reach the victory threshold`;
  // Remove only this bonus: the other bonus may still be needed to finish.
  const deadline = sequenceTime(plan.steps.filter(s => s.kind !== kind), me);
  if (Number.isFinite(deadline) && deadline < lead + 1 - 1e-6)
    return `prepare ${label} now to meet the winning plan's deadline`;
  return null;
}
