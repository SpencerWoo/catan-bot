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

describe("bank trade commitment", () => {
  it("holds an over-limit hand instead of paying a certain loss for an unfunded city", () => {
    const t = players(), us = t.players.get("Us")!;
    us.hand = { ...zeroHand(), wheat: 6, wood: 2 };
    us.bankRatio = { wheat: 3, ore: 3 };
    const board = generateBoard(42);
    const gs = { state: { board, buildings: [{ player: 0 as const, vertexId: 0, kind: "settlement" as const }], roads: [] }, youPlayer: 0 as const };
    const planning = planPosition(t, "Us", gs, { devDeckLeft: 0 });
    planning.builds = planning.builds.filter((b) => b.kind === "city");
    const decision = decideNext({ tracker: t, youName: "Us", fit: rankLiveStrategies(t, "Us")[0], gs, advice: null,
      rolledThisTurn: true, discardLimit: 7, planning });
    expect(decision?.kind).toBe("end-turn");
    expect(us.hand.wheat).toBe(6);
  });

  it("finishes a multi-trade purchase without exchanging the acquired cards back", () => {
    const t = players(), us = t.players.get("Us")!;
    us.hand = { ...zeroHand(), sheep: 7 };
    us.bankRatio = { sheep: 3, wheat: 3, ore: 3 };
    let funding: import("./autopilot").AutopilotDecision["funding"];
    const received = new Set<string>();
    const actions: string[] = [];
    for (let i = 0; i < 3; i++) {
      const decision = decideNext({ tracker: t, youName: "Us", fit: rankLiveStrategies(t, "Us")[0], gs: null, advice: null,
        rolledThisTurn: true, funding });
      actions.push(decision!.kind);
      if (decision?.kind === "bank-trade") {
        expect(received.has(decision.trade!.give)).toBe(false);
        expect(decision.funding?.kind).toBe("dev");
        funding = decision.funding;
        us.hand[decision.trade!.give] -= decision.trade!.giveCount;
        us.hand[decision.trade!.get]++;
        received.add(decision.trade!.get);
      }
    }
    expect(actions).toEqual(["bank-trade", "bank-trade", "buy-dev"]);
  });
});

it("discounts exposed saving while retaining the value of immediate builds", () => {
  const t = players();
  t.players.get('Us')!.hand = { ...zeroHand(), wood: 6, sheep: 5 };
  const board = generateBoard(42);
  const gs = { state: { board, buildings: [{ player: 0 as const, vertexId: 0, kind: 'settlement' as const }], roads: [] }, youPlayer: 0 as const };
  t.discardLimit = 99;
  const safe = planPosition(t, 'Us', gs);
  t.discardLimit = 7;
  const exposed = planPosition(t, 'Us', gs);
  const city = (p: typeof safe) => p.builds.find(b => b.kind === 'city')!;
  expect(city(exposed).score).toBeLessThan(city(safe).score);
  expect(exposed.builds.find(b => b.kind === 'dev')!.score).toBe(safe.builds.find(b => b.kind === 'dev')!.score);
});

it("takes only the necessary connected roads and respects the finite supply", async () => {
  const { roadBonusPath, longestRoad } = await import('./planning');
  const board = generateBoard(42);
  const state: GameState = { board, roads: [], buildings: [] };
  let vertex = 0;
  const visited = new Set([vertex]);
  for (let i = 0; i < 4; i++) {
    const edge = board.edges.find(e => (e.a === vertex && !visited.has(e.b)) || (e.b === vertex && !visited.has(e.a)))!;
    state.roads.push({ edgeId: edge.id, player: 0 });
    vertex = edge.a === vertex ? edge.b : edge.a;
    visited.add(vertex);
  }
  expect(longestRoad(state, 0)).toBe(4);
  const path = roadBonusPath(state, 0, 5, 1)!;
  expect(path).toHaveLength(1);
  expect(longestRoad({ ...state, roads: [...state.roads, { edgeId: path[0], player: 0 }] }, 0)).toBe(5);
  expect(roadBonusPath(state, 0, 7, 1)).toBeNull();
  expect(roadBonusPath(state, 0, 4, 15)).toEqual([]);
  const t = players();
  state.buildings.push({ player: 0, vertexId: 0, kind: "settlement" });
  const gs = { state, youPlayer: 0 as const };
  const inputs = planPosition(t, 'Us', gs).inputs;
  const me = inputs.find(p => p.isYou)!;
  me.longestRoadPath = path;
  me.hand = t.players.get('Us')!.hand = { ...zeroHand(), wood: 1, brick: 1 };
  const early = planPosition(t, 'Us', gs, { inputs });
  expect(early.options.some(b => b.kind === 'road')).toBe(false);
  expect(early.options.some(b => b.kind === 'settlement' && b.roadEdges?.length)).toBe(true);
  expect(early.options.find(b => b.kind === 'dev')!.vp).toBe(0.2);
  me.publicVp = 8;
  const late = planPosition(t, 'Us', gs, { inputs });
  expect(late.builds[0].kind).toBe('road');
  expect(decideNext({ tracker: t, youName: 'Us', fit: rankLiveStrategies(t, 'Us')[0], gs,
    advice: null, rolledThisTurn: true, planning: late })?.kind).toBe('build-road');
  me.holdsLongestRoad = true;
  expect(planPosition(t, 'Us', gs, { inputs }).builds.some(b => b.kind === 'road')).toBe(false);
});
