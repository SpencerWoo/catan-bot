import { BUILD, Hand } from "../engine/winnability";
import { RESOURCES, Resource } from "../engine/types";
import { GameEvent, ResourceDelta } from "./events";

export type TrackingHealth = "exact" | "repairing" | "incomplete";
export interface HandSnapshot {
  mine: Hand;
  opponentTotal: number;
}
export interface LedgerProjection {
  health: TrackingHealth;
  reason: string;
  opponent: Hand | null;
}
const empty = (): Hand => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
const total = (h: ResourceDelta): number => RESOURCES.reduce((s, r) => s + (h[r] ?? 0), 0);

/**
 * Two-player resource conservation. Public bank flows change the combined
 * hands; ALL steals are internal transfers. Subtract our exact private hand
 * from that pool to recover their exact hand, including missing-icon steals.
 * Retain ordered, identified events so duplicates, late rows and reloads can
 * be replayed. A total mismatch never fabricates a resource distribution.
 */
export class HandLedger {
  readonly events = new Map<number, GameEvent>();
  constructor(readonly you: string, readonly opponent: string, public complete = false) {}

  record(id: number, event: GameEvent): void {
    this.events.set(id, event);
  }

  project(snapshot: HandSnapshot): LedgerProjection {
    if (!this.complete) return { health: "incomplete", reason: "Opening resource history missing", opponent: null };
    const pool = empty();
    const own = empty();
    let ownTotal = 0;
    let ownIdentityKnown = true;
    let invalid = false;
    const change = (player: string, delta: ResourceDelta, factor = 1): void => {
      if (player !== this.you && player !== this.opponent) { invalid = true; return; }
      for (const r of RESOURCES) {
        pool[r] += factor * (delta[r] ?? 0);
        if (player === this.you) own[r] += factor * (delta[r] ?? 0);
      }
      if (player === this.you) ownTotal += factor * total(delta);
    };
    for (const [, ev] of [...this.events].sort(([a], [b]) => a - b)) {
      switch (ev.type) {
        case "got": case "starting-resources": case "take-from-bank": change(ev.player, ev.resources); break;
        case "discard": change(ev.player, ev.resources, -1); break;
        case "build": change(ev.player, BUILD[ev.what], -1); break;
        case "buy-dev": change(ev.player, BUILD.dev, -1); break;
        case "bank-trade": change(ev.player, ev.delta); break;
        case "player-trade": {
          const partner = ev.partner ?? (ev.player === this.you ? this.opponent : this.you);
          if (ev.player === partner) { invalid = true; break; }
          change(ev.player, ev.delta);
          change(partner, ev.delta, -1);
          break;
        }
        case "steal-known": case "steal-unknown": {
          const thief = ev.thief ?? this.you;
          const victim = ev.victim ?? this.you;
          if (new Set([thief, victim, this.you, this.opponent]).size !== 2 || thief === victim) {
            invalid = true; break;
          }
          const sign = thief === this.you ? 1 : -1;
          ownTotal += sign;
          if (ev.type === "steal-known") own[ev.resource] += sign;
          else ownIdentityKnown = false;
          break;
        }
        case "monopoly-steal": {
          const sign = ev.player === this.you ? 1 : -1;
          ownTotal += sign * ev.count;
          own[ev.resource] += sign * ev.count;
          break;
        }
      }
    }
    const opponent = empty();
    for (const r of RESOURCES) opponent[r] = pool[r] - snapshot.mine[r];
    const consistent = !invalid && ownTotal === total(snapshot.mine) &&
      total(opponent) === snapshot.opponentTotal &&
      RESOURCES.every((r) => Number.isInteger(opponent[r]) && opponent[r] >= 0 &&
        (!ownIdentityKnown || own[r] === snapshot.mine[r]));
    return consistent
      ? { health: "exact", reason: "1v1 ledger agrees with private hand and both server totals", opponent }
      : { health: "repairing", reason: "Waiting for resource events and server hands to agree", opponent: null };
  }

  /** Serializable history, also used by replay tests and game exports. */
  export(): Array<{ id: number; event: GameEvent }> {
    return [...this.events].sort(([a], [b]) => a - b).map(([id, event]) => ({ id, event }));
  }
}

/** Execution guard: no production guesses, missing history, or empty targets. */
export function confirmedMonopolyHaul(
  players: Iterable<{ name: string; hand: Hand; serverCards: number | null; trackingHealth?: TrackingHealth }>,
  you: string,
  resource: Resource,
): number {
  let haul = 0;
  let opponents = 0;
  for (const p of players) {
    if (p.name === you) continue;
    opponents++;
    if (p.trackingHealth !== "exact" || p.serverCards !== total(p.hand)) return 0;
    haul += p.hand[resource];
  }
  return opponents > 0 ? haul : 0;
}
