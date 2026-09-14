import { Hand } from "../engine/winnability";
import { RESOURCES } from "../engine/types";
import { deckStatus } from "./copilot";
import { TrackerState } from "./tracker";

/** Probability of at least one seven before the next spending opportunity.
 * Follow the no-seven branch without replacement; use the tracker's existing
 * early-refill boundary rather than assuming an exhausted shoe stays cold.
 */
export function sevenExposure(tracker: TrackerState, rolls: number): number {
  const deck = deckStatus(tracker);
  let left = deck.totalRemaining, sevens = deck.remaining.get(7) ?? 6;
  let survival = 1;
  for (let i = 0; i < Math.ceil(rolls) && survival > 0; i++) {
    if (left <= 5) { left = 36; sevens = 6; }
    survival *= Math.max(0, (left - sevens) / left);
    left--;
  }
  return 1 - survival;
}

/** All lost resources have value, including surplus beyond the next build.
 * Value in card units; callers convert at the planner's four cards per point.
 * Fixed-hand estimate: future production and repeated discards are excluded.
 */
export function expectedDiscardLoss(tracker: TrackerState, hand: Hand, limit: number,
  rolls = Math.max(2, tracker.players.size)): number {
  const total = RESOURCES.reduce((n, r) => n + hand[r], 0);
  if (total <= limit) return 0;
  return sevenExposure(tracker, rolls) * Math.floor(total / 2);
}
