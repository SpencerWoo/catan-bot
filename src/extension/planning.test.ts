import { describe, expect, it } from "vitest";
import { generateBoard } from "../engine/board";
import { playerProduction } from "../engine/analysis";
import { GameState } from "../engine/types";
import { createTracker, applyEvent } from "./tracker";
import { planPosition, zeroHand } from "./planning";
import { bestRobberHex, decideNext } from "./autopilot";
import { rankLiveStrategies } from "./copilot";
import { confirmedMonopolyHaul } from "./handLedger";

function players() {
  const t = createTracker("Us");
  for (const player of ["Us", "Them"]) applyEvent(t, { type: "place", player, color: player, what: "settlement" });
  return t;
}
describe("race decisions", () => {
  it("uses a one-card Monopoly when it immediately funds victory, and blocks stale or empty targets", () => {
    const t = players(), us = t.players.get("Us")!, them = t.players.get("Them")!;
    us.hand = { ...zeroHand(), ore: 2, wheat: 2 }; us.serverVp = 9;
    them.hand = { ...zeroHand(), ore: 1 }; them.serverCards = 1; them.trackingHealth = "exact";
    const board = generateBoard(42);
    const gs = { state: { board, buildings: [{ player: 0 as const, vertexId: 0, kind: "settlement" as const }], roads: [] }, youPlayer: 0 as const };
    const decide = () => decideNext({ tracker: t, youName: "Us", fit: rankLiveStrategies(t, "Us")[0], gs, advice: null,
      rolledThisTurn: true, hasMonopoly: true });
    expect(decide()).toMatchObject({ kind: "play-monopoly", resource: "ore" });
    them.hand.ore = 0; them.serverCards = 0;
    expect(confirmedMonopolyHaul(t.players.values(), "Us", "ore")).toBe(0);
    expect(decide()?.kind).not.toBe("play-monopoly");
    them.hand.ore = 1; them.serverCards = 1; them.trackingHealth = "repairing";
    expect(decide()?.kind).not.toBe("play-monopoly");
  });
  it("targets a sole wheat bottleneck, but switches to ore when wheat is already held", () => {
    const board = generateBoard(42);
    for (const hex of board.hexes) { hex.kind = "desert"; hex.token = null; }
    const ore = board.hexes[0], wheat = board.hexes[18];
    ore.kind = "ore"; ore.token = 6; wheat.kind = "wheat"; wheat.token = 5;
    const state: GameState = { board, roads: [], buildings: [ore, wheat].map((h) => ({
      player: 1, kind: "settlement", vertexId: board.vertices.find((v) => v.hexIds.includes(h.id))!.id })) };
    const t = players();
    t.players.get("Them")!.serverVp = 9;
    const choose = (oreHeld: number, wheatHeld: number) => {
      t.players.get("Them")!.hand = { ...zeroHand(), ore: oreHeld, wheat: wheatHeld };
      const planning = planPosition(t, "Us", { state, youPlayer: 0 });
      const input = planning.inputs.find((p) => !p.isYou)!;
      expect(input.production).toEqual(playerProduction(state, 1));
      return bestRobberHex(state, 0, null, undefined, undefined, undefined, planning)?.hex;
    };
    expect(choose(3, 0)).toEqual({ x: wheat.q, y: wheat.r });
    expect(choose(0, 2)).toEqual({ x: ore.q, y: ore.r });
  });
});
