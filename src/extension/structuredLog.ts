import { GameEvent, ResourceDelta } from "./events";
import { Resource } from "../engine/types";

/** Server log IDs are stable, unlike virtual DOM row indices. Private messages
 * can leave ID gaps; those gaps are not missing public resource events. */
export interface StructuredLogEntry {
  text?: Record<string, unknown>;
  from?: number;
}
const resources: Record<number, Resource> = { 1: "wood", 2: "brick", 3: "sheep", 4: "wheat", 5: "ore" };
function cards(value: unknown): ResourceDelta | null {
  if (!Array.isArray(value) || value.some(id => !resources[id])) return null;
  const result: ResourceDelta = {};
  for (const id of value) { const r = resources[id]; result[r] = (result[r] ?? 0) + 1; }
  return result;
}

/** null means unsupported/incomplete evidence, never a fabricated empty hand.
 * Enum mappings are pinned to the retained protocol capture. */
export function parseStructuredLog(entry: StructuredLogEntry, names: Map<number, string>, you: string | null): GameEvent | null {
  const t = entry.text;
  if (!t) return null;
  const player = names.get(t.playerColor as number);
  const ignored = (): GameEvent => ({ type: "ignored" });
  if ([2, 22, 44, 60, 66, 74].includes(t.type as number)) return ignored();
  if (t.type === 49) {
    const tile = t.tileInfo as { diceNumber?: number; resourceType?: number } | undefined;
    return tile?.diceNumber && resources[tile.resourceType!] ?
      { type: "blocked-roll", total: tile.diceNumber, resource: resources[tile.resourceType!] } : null;
  }
  if (!player) return null;
  switch (t.type) {
    case 10: {
      const a = t.firstDice as number, b = t.secondDice as number;
      return [a, b].every(n => Number.isInteger(n) && n >= 1 && n <= 6)
        ? { type: "roll", player, total: a + b } : null;
    }
    case 4: case 5: {
      const what = ({ 0: "road", 2: "settlement", 3: "city" } as const)[t.pieceEnum as 0 | 2 | 3];
      return !what ? null : t.type === 4 ? { type: "place", player, color: String(t.playerColor), what }
        : { type: "build", player, what };
    }
    case 47: {
      const delta = cards(t.cardsToBroadcast);
      return delta && [0, 1].includes(t.distributionType as number)
        ? { type: t.distributionType === 0 ? "starting-resources" : "got", player, resources: delta } : null;
    }
    case 1: return { type: "buy-dev", player };
    case 11: return { type: "move-robber", player };
    case 14: case 15: {
      const delta = cards(t.cardEnums);
      const resource = delta && Object.keys(delta)[0] as Resource | undefined;
      const thief = t.type === 14 ? names.get(entry.from!) : player;
      const victim = t.type === 14 ? player : you;
      if (!thief || !victim || thief === victim) return null;
      return resource ? { type: "steal-known", thief, victim, resource } : { type: "steal-unknown", thief, victim };
    }
    case 20: {
      if (t.cardEnum === 11) return { type: "use-knight", player };
      const card = ({ 13: "monopoly", 14: "road-building", 15: "year-of-plenty" } as const)[t.cardEnum as 13 | 14 | 15];
      return card ? { type: "use-dev", player, card } : null;
    }
    case 21: case 55: {
      const delta = cards(t.cardEnums);
      return delta ? { type: t.type === 21 ? "take-from-bank" : "discard", player, resources: delta } : null;
    }
    case 86: {
      const resource = resources[t.cardEnum as number], count = t.amountStolen as number;
      return resource && Number.isInteger(count) && count >= 0 ? { type: "monopoly-steal", player, resource, count } : null;
    }
    case 116: {
      const before = cards(t.givenCardEnums), after = cards(t.receivedCardEnums);
      if (!before || !after) return null;
      const delta = { ...after };
      for (const r of Object.keys(before) as Resource[]) delta[r] = (delta[r] ?? 0) - before[r]!;
      return { type: "bank-trade", player, delta,
        gave: Object.values(before).reduce((a, b) => a + b, 0), took: Object.values(after).reduce((a, b) => a + b, 0) };
    }
    case 45: return { type: "game-over", winner: player };
    default: return null;
  }
}
