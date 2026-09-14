import { expect, it } from "vitest";
import { generateBoard } from "../engine/board";
import { GameLog } from "./gameLog";
import { replayPlanning } from "./replay";
import { zeroHand } from "./planning";

it("replays a recorded decision with exact holdings and counts held VP once", () => {
  const board = generateBoard(42);
  const input = { name: "Us", isYou: true, playerId: 0, publicVp: 7, hiddenVp: 2,
    settlementsLeft: 0, citiesLeft: 1, roadsLeft: 0, settlementsOnBoard: 1,
    settlementSpotOpen: false, knightsPlayed: 0, longestRoadLen: 0,
    hand: { ...zeroHand(), ore: 3, wheat: 2 }, production: zeroHand() };
  const log: GameLog = { version: "replay-test", at: "2026-09-14", durationMs: 1,
    you: "Us", won: true, winner: "Us", complete: true, playerCount: 2,
    settings: { friendlyRobber: false, victoryPointsToWin: 10, discardLimit: 7 },
    recommendedStrategy: null, board: { tiles: [], ports: [] }, boardGeometry: board, finalPlayers: [], moves: [],
    decisions: [{ t: 1, eventIndex: 2, decision: { kind: "build-city", describe: "winning city" },
      hands: [{ name: "Us", hand: input.hand, total: 5, publicVp: 7, health: "exact" }],
      buildings: [], roads: [], planningInputs: [input], bankDevCards: 0,
      position: { buildings: [{ vertexId: 0, player: 0, kind: "settlement" }], roads: [] } }] };
  const replay = replayPlanning(JSON.parse(JSON.stringify(log)), 0);
  expect(replay.planning?.gap).toBe(1);
  expect(replay.planning?.horizon.turns).toBe(0);
  expect(replay.planning?.builds[0].kind).toBe("city");
  log.decisions![0].hands[0].health = "incomplete";
  expect(replayPlanning(log, 0).reason).toContain("incomplete");
  delete log.decisions;
  expect(replayPlanning(log, 0).reason).toContain("text-only");
});
