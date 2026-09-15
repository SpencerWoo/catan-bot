import { Hand } from "../engine/winnability";
import { RESOURCES, pips } from "../engine/types";
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

/** Expected cards lost before the next spending opportunity. Enumerate grouped
 * dice outcomes, including production, repeat discards, and the existing refill
 * boundary. Numbers producing the same card count are interchangeable here.
 * Robber movement/steals after a seven are not forecast. */
export function expectedDiscardLoss(tracker: TrackerState, hand: Hand, limit: number,
  rolls = Math.max(2, tracker.players.size), income: ReadonlyMap<number, number> = new Map()): number {
  const total = RESOURCES.reduce((n, r) => n + hand[r], 0);
  const deck = deckStatus(tracker);
  const groups = new Map<number, { full: number; left: number }>();
  for (let n = 2; n <= 12; n++) {
    const gain = n === 7 ? -1 : income.get(n) ?? 0;
    const group = groups.get(gain) ?? { full: 0, left: 0 };
    group.full += pips(n);
    group.left += deck.remaining.get(n) ?? pips(n);
    groups.set(gain, group);
  }
  const gains = [...groups.keys()];
  const full = [...groups.values()].map(g => g.full);
  const memo = new Map<string, number>();
  const visit = (cards: number, left: number[], steps: number): number => {
    if (steps <= 0) return 0;
    let count = left.reduce((a, b) => a + b, 0);
    if (count <= 5) { left = full; count = 36; }
    const key = `${cards}/${steps}/${left.join(",")}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let loss = 0;
    for (let i = 0; i < gains.length; i++) {
      if (!left[i]) continue;
      const discarded = gains[i] === -1 && cards > limit ? Math.floor(cards / 2) : 0;
      const next = [...left]; next[i]--;
      loss += left[i] / count * (discarded + visit(cards - discarded + Math.max(0, gains[i]), next, steps - 1));
    }
    memo.set(key, loss);
    return loss;
  };
  return visit(total, [...groups.values()].map(g => g.left), Math.ceil(rolls));
}

/** Cards produced on each dice total; board state takes precedence over learned income. */
export function discardIncome(tracker: TrackerState,
  gs: { state: import("../engine/types").GameState; youPlayer: import("../engine/types").PlayerId | null } | null,
  robberHex?: { x: number; y: number } | null): Map<number, number> {
  const income = new Map<number, number>();
  if (gs && gs.youPlayer !== null) {
    for (const b of gs.state.buildings.filter(b => b.player === gs.youPlayer)) {
      for (const id of gs.state.board.vertices[b.vertexId].hexIds) {
        const h = gs.state.board.hexes[id];
        if (h.kind === "desert" || h.token === null || (h.q === robberHex?.x && h.r === robberHex.y)) continue;
        income.set(h.token, (income.get(h.token) ?? 0) + (b.kind === "city" ? 2 : 1));
      }
    }
  } else {
    const you = tracker.youName ? tracker.players.get(tracker.youName) : undefined;
    for (const [n, cards] of you?.incomeByNumber ?? []) {
      income.set(n, RESOURCES.reduce((sum, r) => sum + (cards[r] ?? 0), 0));
    }
  }
  return income;
}
