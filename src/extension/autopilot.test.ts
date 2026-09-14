// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import {
  colonistCornerToPixel,
  colonistEdgeToPixels,
  findVertexAt,
  generateBoard,
  vertexPips,
} from "../engine/board";
import { pixelToColonistCorner, pixelsToColonistEdge } from "./coords";
import { DISCARD_BANNER, MOVE_ROBBER_BANNER } from "./domActions";
import { ProtocolLearner } from "./protocolLearner";
import {
  Autopilot,
  bestPlaceableNow,
  bestRobberHex,
  decideNext,
  planBankTrade,
  tradeTowardCost,
} from "./autopilot";
import { createTracker, applyEvent, applyServerPlayerState, findDiscardLimit } from "./tracker";
import { deckStatus, rankLiveStrategies } from "./copilot";
import { distanceFromPlayer, isVertexBuildable } from "../engine/analysis";
import { GameState, pips } from "../engine/types";

const board = generateBoard(42);

describe("coordinate reverse-mapping", () => {
  it("round-trips every vertex through colonist corner coords", () => {
    for (const v of board.vertices) {
      const corner = pixelToColonistCorner(v.x, v.y);
      expect(corner).not.toBeNull();
      const px = colonistCornerToPixel(corner!);
      expect(findVertexAt(board, px.x, px.y)?.id).toBe(v.id);
    }
  });

  it("round-trips every edge through colonist edge coords", () => {
    for (const e of board.edges) {
      const wire = pixelsToColonistEdge(board.vertices[e.a], board.vertices[e.b]);
      expect(wire).not.toBeNull();
      const [p1, p2] = colonistEdgeToPixels(wire!);
      const ids = [findVertexAt(board, p1.x, p1.y)?.id, findVertexAt(board, p2.x, p2.y)?.id];
      expect(ids.sort()).toEqual([e.a, e.b].sort());
    }
  });
});

describe("protocol learner", () => {
  beforeEach(() => localStorage.clear());

  it("pairs a confirmed action with the frame that caused it", () => {
    const learner = new ProtocolLearner();
    learner.recordOutbound({ id: 10, data: { type: 99, payload: "heartbeat" } }, 1000);
    learner.recordOutbound(
      { id: 11, data: { type: 50, payload: [{ hexCorner: { x: 1, y: -1, z: 0 }, kind: 2 }] } },
      2000,
    );
    learner.confirm("build-settlement", 2500);
    expect(learner.status()["build-settlement"]).toBe(true);

    const frame = learner.buildFrame("build-settlement", { x: 0, y: 2, z: 1 }) as {
      data: { payload: Array<{ hexCorner: { x: number; y: number; z: number } }> };
    };
    expect(frame.data.payload[0].hexCorner).toEqual({ x: 0, y: 2, z: 1 });
  });

  it("skips coordinate-less frames when the action needs coordinates", () => {
    const learner = new ProtocolLearner();
    learner.recordOutbound({ id: 1, data: { type: 50, payload: [{ hexCorner: { x: 0, y: 0, z: 0 } }] } }, 1000);
    learner.recordOutbound({ id: 2, data: { type: 99 } }, 1800); // heartbeat after the action
    learner.confirm("build-road", 2000);
    // paired past the heartbeat to the coordinate frame
    expect(learner.status()["build-road"]).toBe(true);
  });

  it("bumps sequence counters on built frames", () => {
    const learner = new ProtocolLearner();
    for (let i = 1; i <= 4; i++) {
      learner.recordOutbound({ id: 100 + i, data: { type: 7 } }, i * 1000);
    }
    learner.confirm("roll", 4500);
    const frame = learner.buildFrame("roll") as { id: number };
    expect(frame.id).toBe(105); // last seen 104, bumped
  });

  it("un-learns a template on discard (self-correction)", () => {
    const learner = new ProtocolLearner();
    learner.recordOutbound({ id: 1, data: { type: 7 } }, 1000);
    learner.confirm("roll", 1200);
    expect(learner.status().roll).toBe(true);
    learner.discard("roll");
    expect(learner.status().roll).toBe(false);
    expect(learner.buildFrame("roll")).toBeNull();
  });

  it("persists templates across instances", () => {
    const a = new ProtocolLearner();
    a.recordOutbound({ id: 1, data: { type: 7 } }, 1000);
    a.confirm("roll", 1200);
    const b = new ProtocolLearner();
    b.load();
    expect(b.status().roll).toBe(true);
  });
});

function trackerWith(hand: Partial<Record<string, number>>, income = true) {
  const t = createTracker("Nick");
  applyEvent(t, { type: "place", player: "Nick", color: "#c00", what: "settlement" });
  if (income) {
    applyEvent(t, { type: "roll", player: "Nick", total: 8 });
    applyEvent(t, { type: "got", player: "Nick", resources: { ore: 2, wheat: 1 } });
  }
  const p = t.players.get("Nick")!;
  for (const [r, n] of Object.entries(hand)) (p.hand as Record<string, number>)[r] = n ?? 0;
  return t;
}

function gsWithSettlement(): { state: GameState; youPlayer: 0 } {
  const v = board.vertices.find((x) => x.hexIds.length === 3)!;
  return {
    state: {
      board,
      buildings: [{ vertexId: v.id, player: 0, kind: "settlement" }],
      roads: [],
    },
    youPlayer: 0,
  };
}

describe("robber banner detection", () => {
  it("matches instructions addressed to you", () => {
    for (const s of [
      "Move the robber",
      "move robber",
      "You must move the Robber",
      "Place the robber",
      "Select a tile for the robber",
    ]) {
      expect(MOVE_ROBBER_BANNER.test(s), s).toBe(true);
    }
  });

  it("ignores opponents' banners and passive robber mentions", () => {
    for (const s of [
      "yoyoprashant is moving the robber",
      "Waiting for LadyboyNick to move the robber",
      "Robber",
      "Friendly Robber",
      "moved Robber",
    ]) {
      expect(MOVE_ROBBER_BANNER.test(s), s).toBe(false);
    }
  });
});

describe("setup placement portfolio", () => {
  it("second settlement covers the resources the first one lacks", async () => {
    const { rankSetupSpots } = await import("./placement");
    const { RESOURCES } = await import("../engine/types");
    const neutral = Object.fromEntries(RESOURCES.map((r) => [r, 1])) as Record<(typeof RESOURCES)[number], number>;
    // first settlement on the corner with the most brick+sheep pips and NO wheat/wood
    const kinds = (v: { hexIds: number[] }) => v.hexIds.map((h) => board.hexes[h]).filter((h) => h.kind !== "desert");
    const first = board.vertices
      .filter((v) => v.hexIds.length === 3 && kinds(v).every((h) => h.kind === "brick" || h.kind === "sheep" || h.kind === "ore"))
      .sort((a, b) => b.hexIds.length - a.hexIds.length)[0];
    if (!first) return; // board 42 has no such corner — nothing to assert
    const state: GameState = { board, buildings: [{ vertexId: first.id, player: 0, kind: "settlement" }], roads: [] };
    const top = rankSetupSpots(state, 0, neutral, 3);
    // every top pick adds wheat or wood (what the portfolio lacks) when any buildable corner offers them
    const offers = board.vertices.some((v) => kinds(v).some((h) => h.kind === "wheat" || h.kind === "wood"));
    if (offers) {
      expect(top.length).toBeGreaterThan(0);
      expect(kinds(board.vertices[top[0].vertexId]).some((h) => h.kind === "wheat" || h.kind === "wood")).toBe(true);
      expect(top[0].notes.join(" ")).toMatch(/adds .*(wheat|wood)/);
    }
  });

  it("starting resources = one card per adjacent non-desert hex", async () => {
    const { startingResourcesFor } = await import("./placement");
    const v = board.vertices.find((v) => v.hexIds.length === 3)!;
    const res = startingResourcesFor({ board, buildings: [], roads: [] }, v.id);
    const kinds = v.hexIds.map((h) => board.hexes[h].kind).filter((k) => k !== "desert");
    for (const k of new Set(kinds)) expect(res[k]).toBe(kinds.filter((x) => x === k).length);
    expect(Object.values(res).reduce((a, b) => a + b, 0)).toBe(kinds.length);
  });

  it("second-player doubling: plans a legal pair and evaluates the second pick in the combined portfolio", async () => {
    const { advisePlacement, rankSetupSpots, placementWeights } = await import("./placement");
    // opp has placed exactly one settlement, we have none -> we're second and
    // will place twice back-to-back; only our SECOND placement pays out.
    const oppAt = board.vertices.findIndex((v) => v.hexIds.length === 3);
    const state: GameState = {
      board,
      buildings: [{ vertexId: oppAt, player: 1, kind: "settlement" }],
      roads: [],
    };
    const advice = advisePlacement(state, 0)!;
    expect(advice.phase).toBe("setup");
    expect(advice.heading).toMatch(/TWICE in a row/i);
    expect(advice.note).toMatch(/back-to-back|2nd collects/i);
    expect(advice.spots.length).toBe(2);
    expect(advice.spots[0].label).toMatch(/place NOW/i);
    expect(advice.spots[1].label).toMatch(/pays the starting hand/i);
    const first = advice.spots[0].vertexId;
    const second = advice.spots[1].vertexId;
    expect(board.vertices[first].adjacent).not.toContain(second);
    expect(first).not.toBe(second);
    const after = { ...state, buildings: [...state.buildings, { vertexId: first, player: 0 as const, kind: "settlement" as const }] };
    expect(rankSetupSpots(after, 0, placementWeights(board), 1)[0].vertexId).toBe(second);
  });

  it("second settlement as second player notes that this placement pays", async () => {

    const { advisePlacement } = await import("./placement");
    const ours = board.vertices.findIndex((v) => v.hexIds.length === 3);
    const oppAt = board.vertices.findIndex((v) => v.hexIds.length === 3 && v.id !== ours);
    const state: GameState = {
      board,
      buildings: [
        { vertexId: ours, player: 0, kind: "settlement" },
        { vertexId: oppAt, player: 1, kind: "settlement" },
      ],
      // our setup road is already down, so it's genuinely time to pick the
      // second settlement (otherwise advice correctly points at the road)
      roads: [
        { edgeId: board.edges.findIndex((e) => e.a === ours || e.b === ours), player: 0 },
      ],
    };
    const advice = advisePlacement(state, 0)!;
    expect(advice.phase).toBe("setup");
    expect(advice.note).toMatch(/COLLECTS the starting resources/i);
  });
});

describe("placement weights", () => {
  it("keeps scarcity to ~40% so pips and diversity decide placement", async () => {
    const { placementWeights } = await import("./placement");
    const { scarcityWeights } = await import("../engine/analysis");
    const full = scarcityWeights(board);
    const soft = placementWeights(board);
    for (const r of ["wood", "brick", "sheep", "wheat", "ore"] as const) {
      // always strictly closer to 1 than the full scarcity weight (unless it's already 1)
      expect(Math.abs(soft[r] - 1)).toBeLessThanOrEqual(Math.abs(full[r] - 1) + 1e-9);
      expect(soft[r]).toBeGreaterThanOrEqual(1 + 0.4 * (0.6 - 1)); // >= 0.84
      expect(soft[r]).toBeLessThanOrEqual(1 + 0.4 * (1.8 - 1)); // <= 1.32
    }
  });

  it("a 12-pip three-resource corner out-ranks a scarce 8-pip two-resource one", async () => {
    const { rankSetupSpots, placementWeights } = await import("./placement");
    const { vertexPips } = await import("../engine/board");
    const state: GameState = { board, buildings: [], roads: [] };
    const top = rankSetupSpots(state, 0, placementWeights(board), 3);
    // the top pick must be among the high-pip corners, never a sub-9 corner
    expect(vertexPips(board, top[0].vertexId)).toBeGreaterThanOrEqual(9);
  });
});

describe("coverage bonus", () => {
  it("a corner bringing a resource we don't produce beats piling on one we do", async () => {
    const { rankSetupSpots, placementWeights } = await import("./placement");
    // first settlement: the corner with the most ORE pips and no brick
    const kinds = (v: { hexIds: number[] }) => v.hexIds.map((h) => board.hexes[h]).filter((h) => h.kind !== "desert");
    const first = board.vertices
      .filter((v) => kinds(v).some((h) => h.kind === "ore") && !kinds(v).some((h) => h.kind === "brick"))
      .sort((a, b) => vertexPips(board, b.id) - vertexPips(board, a.id))[0];
    if (!first) return;
    const state: GameState = { board, buildings: [{ vertexId: first.id, player: 0, kind: "settlement" }], roads: [] };
    const top = rankSetupSpots(state, 0, placementWeights(board), 5);
    // at least one of the top picks must add brick (a core resource we lack)
    expect(top.some((t) => kinds(board.vertices[t.vertexId]).some((h) => h.kind === "brick"))).toBe(true);
  });
});

describe("contested corners", () => {
  it("measures how fast an opponent can reach a corner, through roads, not through our buildings", async () => {
    const { opponentDistance, isContested } = await import("./placement");
    const V = board.vertices.find((v) => v.hexIds.length === 3 && v.adjacent.length === 3)!;
    const N = V.adjacent[0];
    const M = board.vertices[N].adjacent.find((x) => x !== V.id && !V.adjacent.includes(x))!;
    const edge = (a: number, b: number) =>
      board.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))!;
    // no opponents at all -> unreachable
    const solo: GameState = { board, buildings: [{ vertexId: V.id, player: 0, kind: "settlement" }], roads: [] };
    expect(opponentDistance(solo, 0, M)).toBe(Infinity);
    // opponent settlement at V: M is 2 roads from them
    const s1: GameState = { board, buildings: [{ vertexId: V.id, player: 1, kind: "settlement" }], roads: [] };
    expect(opponentDistance(s1, 0, M)).toBe(2);
    // ...and 1 road once they've laid V-N
    const s2: GameState = { ...s1, roads: [{ edgeId: edge(V.id, N).id, player: 1 }] };
    expect(opponentDistance(s2, 0, M)).toBe(1);
    expect(isContested(s2, 0, M, 2)).toBe(true); // they need 1, we need 2
    expect(isContested(s2, 0, M, 0)).toBe(false); // we're already there
  });

  it("setup road avoids a corner an opponent is already building toward", async () => {
    const { advisePlacement, roadPathTo, opponentDistance } = await import("./placement");
    // Our pending settlement V: an INTERIOR corner (most corners reachable
    // within 4 roads) so there are real alternatives. Find the target T the
    // plain rule picks, park an opponent 1 road from T, and check the advised
    // road no longer heads for T.
    const reach = (v: { id: number }) =>
      board.vertices.filter((t) => {
        const n = roadPathTo({ board, buildings: [], roads: [] }, 0, t.id, [v.id]).length;
        return n > 0 && n <= 4;
      }).length;
    const V = [...board.vertices]
      .filter((v) => v.hexIds.length === 3 && v.adjacent.length === 3)
      .sort((a, b) => reach(b) - reach(a))[0];
    const base: GameState = { board, buildings: [{ vertexId: V.id, player: 0, kind: "settlement" }], roads: [] };
    const before = advisePlacement(base, 0)!;
    expect(before.phase).toBe("setup");
    expect(before.roadEdges).toHaveLength(1);
    const T = before.spots[0].vertexId;
    // an opponent corner one road from T, not adjacent to V, and not touching T
    const O = board.vertices[T].adjacent
      .flatMap((n) => board.vertices[n].adjacent)
      .find((o) => o !== T && o !== V.id && !board.vertices[T].adjacent.includes(o) && !V.adjacent.includes(o))!;
    const N = board.vertices[T].adjacent.find((n) => board.vertices[n].adjacent.includes(O) && n !== V.id)!;
    const edge = (a: number, b: number) =>
      board.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))!;
    const contested: GameState = {
      board,
      buildings: [...base.buildings, { vertexId: O, player: 1, kind: "settlement" }],
      roads: [{ edgeId: edge(O, N).id, player: 1 }],
    };
    expect(opponentDistance(contested, 0, T)).toBe(1);
    const ourDist = roadPathTo(contested, 0, T, [V.id]).length;
    if (ourDist <= 1) return; // we could still claim it first — no assertion
    // only meaningful if some other reachable corner is NOT contested
    const alternative = board.vertices.some((t) => {
      const n = roadPathTo(contested, 0, t.id, [V.id]).length;
      return t.id !== T && n > 0 && n <= 4 && opponentDistance(contested, 0, t.id) > n;
    });
    if (!alternative) return;
    const after = advisePlacement(contested, 0)!;
    expect(after.spots[0].vertexId).not.toBe(T);
    expect(after.note).toMatch(/opponent is 1 road/);
  });
});

describe("player-trade responses", () => {
  it("accepts a 1:1 that completes the next build from surplus, declines the rest", async () => {
    const { decideTradeResponse } = await import("./trading");
    const city = { ore: 3, wheat: 2 };
    const settlement = { wood: 1, brick: 1, sheep: 1, wheat: 1 };
    const hand = { wood: 0, brick: 0, sheep: 3, wheat: 2, ore: 2 };
    // they give ore, want sheep: finishes the city from surplus sheep -> accept
    expect(decideTradeResponse(hand, { offered: { ore: 1 }, wanted: { sheep: 1 } }, [city]).accept).toBe(true);
    // they want wheat the city needs -> decline
    expect(decideTradeResponse(hand, { offered: { ore: 1 }, wanted: { wheat: 1 } }, [city]).accept).toBe(false);
    // 2-for-1 against us -> decline when the hand is comfortable (limit 9)...
    expect(decideTradeResponse(hand, { offered: { ore: 1 }, wanted: { sheep: 2 } }, [city], 9).accept).toBe(false);
    // ...but AT the discard limit a 2:1 that completes the city is worth it (the
    // extra sheep was a discard risk anyway)
    expect(decideTradeResponse(hand, { offered: { ore: 1 }, wanted: { sheep: 2 } }, [city], 7).accept).toBe(true);
    // brings nothing we're short of -> decline
    expect(decideTradeResponse(hand, { offered: { sheep: 1 }, wanted: { ore: 1 } }, [city]).accept).toBe(false);
    // can't pay -> decline
    expect(decideTradeResponse(hand, { offered: { ore: 1 }, wanted: { wood: 1 } }, [city]).accept).toBe(false);
    // nothing in the plan we're short of -> decline
    expect(decideTradeResponse({ ...hand, ore: 3 }, { offered: { ore: 1 }, wanted: { sheep: 1 } }, [city]).accept).toBe(false);
    // plan order matters: settlement first, they offer wood for sheep -> accept
    expect(decideTradeResponse(hand, { offered: { wood: 1 }, wanted: { sheep: 1 } }, [settlement, city]).accept).toBe(true);
  });
});

describe("risk profile and opponent weakness", () => {
  // minimal synthetic board: two hexes sharing a vertex, one extra for us
  const miniBoard = {
    seed: 1,
    hexes: [
      { id: 0, q: 0, r: 0, kind: "ore" as const, token: 2, x: 0, y: 0, cx: -1, cy: -0.5 },
      { id: 1, q: 1, r: 0, kind: "sheep" as const, token: 6, x: 2, y: 0, cx: 2, cy: -0.5 },
      { id: 2, q: 0, r: 1, kind: "wood" as const, token: 9, x: 0, y: 2, cx: 0, cy: 2 },
    ],
    vertices: [
      { id: 0, x: -1, y: -1, hexIds: [0], adjacent: [1], port: null as null },
      { id: 1, x: 1, y: -1, hexIds: [0, 1], adjacent: [0, 2], port: null as null },
      { id: 2, x: 3, y: 1, hexIds: [1], adjacent: [1], port: null as null },
      { id: 3, x: -1, y: 1.5, hexIds: [0, 2], adjacent: [4], port: null as null },
      { id: 4, x: 1, y: 2.5, hexIds: [2], adjacent: [3, 5], port: null as null },
      { id: 5, x: 3, y: 3, hexIds: [2], adjacent: [4], port: null as null },
    ],
    edges: [
      { id: 0, a: 0, b: 1 },
      { id: 1, a: 1, b: 2 },
      { id: 2, a: 3, b: 4 },
      { id: 3, a: 4, b: 5 },
    ],
  };

  it("starvation: robber targets the victim's thinnest produced resource", async () => {
    const { opponentStarveResource, bestRobberHex } = await import("./autopilot");
    const state: GameState = {
      board: miniBoard,
      buildings: [
        // opponent touches BOTH the big sheep tile and the thin ore tile
        { vertexId: 1, player: 1 as const, kind: "settlement" as const },
        // we touch the wood tile
        { vertexId: 5, player: 0 as const, kind: "settlement" as const },
      ],
      roads: [],
    };
    expect(opponentStarveResource(state, 1)).toBe("ore");
    // equal due-ness for both numbers -> the starve weight (x1.4) must pick ore
    const t = bestRobberHex(state, 0, null, () => true, (n) => (n === 2 || n === 6 ? 1 / 18 : 0), "ore");
    expect(t?.describe).toContain("ore");
    expect(t?.describe).toContain("starving");
  });

  it("saves for growth instead of crediting an early speculative army", async () => {
    const { riskModeOf } = await import("./autopilot");
    expect(riskModeOf(0.2)).toBe("lotto");
    const t = trackerWith({ sheep: 1, wheat: 1, ore: 1 }, false);
    t.players.get("Nick")!.serverVp = 1;
    applyEvent(t, { type: "place", player: "Ava", color: "#E27174", what: "settlement" });
    const ava = t.players.get("Ava")!;
    ava.serverVp = 5;
    const gs = {
      state: {
        board,
        buildings: [
          { vertexId: board.vertices.find((v) => v.hexIds.length === 3)!.id, player: 0 as const, kind: "settlement" as const },
          { vertexId: board.vertices.find((v) => v.hexIds.length === 3 && v.adjacent.length === 3)!.id, player: 1 as const, kind: "city" as const },
        ],
        roads: [],
      },
      youPlayer: 0 as const,
    };
    const fits = rankLiveStrategies(t, "Nick");
    // pick a plan that actually contains dev cards (what lotto mode preserves)
    const fit = fits.find((f) => f.strategy.buildOrder.includes("dev"))!;
    const d = decideNext({
      tracker: t, youName: "Nick", fit, gs, advice: null, rolledThisTurn: true,
    });
    expect(d?.kind).toBe("end-turn");
  });


});

describe("autopilot decisions", () => {
  it("rolls first on its turn", () => {
    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: fits[0],
      gs: gsWithSettlement(),
      advice: null,
      rolledThisTurn: false,
    });
    expect(d?.kind).toBe("roll");
  });

  it("upgrades to a city when affordable, with real coordinates", () => {
    const t = trackerWith({ ore: 3, wheat: 2 });
    const fits = rankLiveStrategies(t, "Nick");
    const gs = gsWithSettlement();
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: fits[0],
      gs,
      advice: null,
      rolledThisTurn: true,
    });
    expect(d?.kind).toBe("build-city");
    const px = colonistCornerToPixel(d!.coord!);
    expect(findVertexAt(board, px.x, px.y)?.id).toBe(gs.state.buildings[0].vertexId);
  });

  it("ends the turn when nothing is affordable", () => {
    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: fits[0],
      gs: gsWithSettlement(),
      advice: null,
      rolledThisTurn: true,
    });
    expect(d?.kind).toBe("end-turn");
  });

  it("finds no placeable spot when the network is blocked", () => {
    const gs = gsWithSettlement();
    // the only network vertex is the settlement itself — occupied
    expect(bestPlaceableNow(gs.state, 0)).toBeNull();
  });

  it("buys a dev toward the final knight needed for victory", () => {
    const t = trackerWith({ ore: 1, sheep: 1, wheat: 1 });
    t.players.get("Nick")!.serverVp = 8;
    t.players.get("Nick")!.knightsPlayed = 2; // next knight can supply the winning bonus
    const fits = rankLiveStrategies(t, "Nick");
    const cityDev = fits.find((f) => f.strategy.id === "city-dev")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: cityDev,
      gs: null, // no board — dev-buy still works
      advice: null,
      rolledThisTurn: true,
    });
    expect(d?.kind).toBe("buy-dev");
  });

  it("expands (does NOT buy dev) early, even when a dev is affordable", () => {
    // fresh game, low VP -> growth phase. With no board to place on, it saves
    // toward expansion rather than buying the affordable dev card.
    const t = trackerWith({ ore: 1, sheep: 1, wheat: 1 });
    const fits = rankLiveStrategies(t, "Nick");
    const cityDev = fits.find((f) => f.strategy.id === "city-dev")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: cityDev,
      gs: null,
      advice: null,
      rolledThisTurn: true,
    });
    expect(d?.kind).not.toBe("buy-dev");
  });

  it("saves for production when a city is not affordable this turn", () => {
    // one settlement to upgrade but 2 ore short with nothing to trade; no spot
    // for a settlement. Dev is affordable — use the cards rather than feed a 7.
    const t = trackerWith({ ore: 2, sheep: 1, wheat: 2 }, false);
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t, youName: "Nick", fit: fits[0], gs: gsWithSettlement(), advice: null, rolledThisTurn: true,
    });
    expect(d?.kind).toBe("end-turn");
    expect(d?.describe).toContain("save for");
  });

  it("does not automatically spend the city reserve on a speculative knight", () => {
    const gs = gsWithSettlement();
    const v = gs.state.board.vertices[gs.state.buildings[0].vertexId];
    const hex = gs.state.board.hexes[v.hexIds[0]];
    const t = trackerWith({ ore: 2, sheep: 1, wheat: 2 }, false);
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t, youName: "Nick", fit: fits[0], gs, advice: null, rolledThisTurn: true,
      robberHex: { x: hex.q, y: hex.r }, knightAvailable: false,
    });
    expect(d?.kind).toBe("end-turn");
    expect(d?.describe).toContain("save for");
  });

  it("does not use generic held-card count as a development purchase cutoff", () => {
    const t = trackerWith({ ore: 1, sheep: 1, wheat: 1 }, false);
    t.players.get("Nick")!.devCards = 2; // two unplayed already
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t, youName: "Nick", fit: fits[0], gs: gsWithSettlement(), advice: null, rolledThisTurn: true,
    });
    t.players.get("Nick")!.devCards = 0;
    const withoutHeld = decideNext({ tracker: t, youName: "Nick", fit: fits[0], gs: gsWithSettlement(), advice: null, rolledThisTurn: true });
    expect(d?.kind).toBe(withoutHeld?.kind);
  });

  it("near the limit, trades toward a reachable city before buying a dev card", () => {
    // 9 cards: ore+sheep+wheat afford a dev, but 4:1 surplus can reach the city
    const t = trackerWith({ ore: 2, sheep: 5, wheat: 2 }, false);
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t, youName: "Nick", fit: fits[0], gs: gsWithSettlement(), advice: null, rolledThisTurn: true,
    });
    expect(d?.kind).toBe("bank-trade");
    expect(d?.trade?.get).toBe("ore");
  });



  it("does not buy a dev card when the bank is sold out", () => {
    const t = trackerWith({ ore: 1, sheep: 1, wheat: 1 });
    t.players.get("Nick")!.serverVp = 8; // late phase, where dev-buying applies
    const fits = rankLiveStrategies(t, "Nick");
    const cityDev = fits.find((f) => f.strategy.id === "city-dev")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: cityDev,
      gs: null,
      advice: null,
      rolledThisTurn: true,
      bankDevCards: 0, // sold out
    });
    expect(d?.kind).not.toBe("buy-dev");
    expect(d?.kind).toBe("end-turn"); // nothing else affordable/reachable
  });

  it("holds an early knight even when army appears in the eventual plan", () => {
    const t = trackerWith({}); // ~3 cards, under the limit
    t.players.get("Nick")!.knightsPlayed = 2;
    const fits = rankLiveStrategies(t, "Nick");
    const cityDev = fits.find((f) => f.strategy.id === "city-dev")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: cityDev,
      gs: gsWithSettlement(),
      advice: null,
      rolledThisTurn: false, // haven't rolled
      knightAvailable: true,
      robberHex: { x: 99, y: 99 }, // robber on nobody
    });
    expect(d?.kind).toBe("roll");
  });



  it("STOPS playing knights once it holds Largest Army (discipline)", () => {
    const t = trackerWith({});
    t.players.get("Nick")!.knightsPlayed = 3; // we already hold Largest Army
    const fits = rankLiveStrategies(t, "Nick");
    const cityDev = fits.find((f) => f.strategy.id === "city-dev")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: cityDev,
      gs: gsWithSettlement(),
      advice: null,
      rolledThisTurn: false,
      knightAvailable: true,
      robberHex: { x: 99, y: 99 }, // robber not on our tile
    });
    expect(d?.kind).not.toBe("play-knight"); // hold the extra knights
  });



  it("plays knights to STEAL a win-critical Largest Army race", () => {
    const t = trackerWith({});
    t.players.get("Nick")!.knightsPlayed = 5;
    t.players.get("Nick")!.serverVp = 8;
    applyEvent(t, { type: "place", player: "Ava", color: "#E27174", what: "settlement" });
    for (let i = 0; i < 5; i++) applyEvent(t, { type: "use-knight", player: "Ava" });
    const ava = t.players.get("Ava")!;
    ava.serverVp = 8; // Ava at 8 VP holding LA — she wins next build unless we take it
    const fits = rankLiveStrategies(t, "Nick");
    const cityDev = fits.find((f) => f.strategy.id === "city-dev")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: cityDev,
      gs: gsWithSettlement(),
      advice: null,
      rolledThisTurn: true,
      knightAvailable: true,
      robberHex: { x: 99, y: 99 },
    });
    expect(d?.kind).toBe("play-knight");
    expect(d?.describe).toContain("Largest Army");
  });

  it("port-aware trading: gives the resource with the best (lowest) ratio", () => {
    // surplus of both wood (4:1) and sheep (2:1 port); need wheat -> give sheep
    const hand = { wood: 5, brick: 0, sheep: 5, wheat: 0, ore: 0 };
    const ratios = { wood: 4, sheep: 2 };
    const weights = { wood: 1, brick: 1, sheep: 1, wheat: 1.5, ore: 1.6 };
    const trade = tradeTowardCost(hand, ratios, { wheat: 2 }, weights);
    expect(trade?.give).toBe("sheep");
    expect(trade?.giveCount).toBe(2); // 2:1 port, not 4:1
  });

  it("rolls first, then plays the knight, when blocked AND over the discard limit", () => {
    // 10 cards (> limit 9): a 7 would force a discard, so roll before the knight
    const t = trackerWith({ sheep: 7, ore: 3 }, false);
    const gs = gsWithSettlement();
    const myHex = board.hexes[board.vertices[gs.state.buildings[0].vertexId].hexIds[0]];
    const fits = rankLiveStrategies(t, "Nick");
    const cityDev = fits.find((f) => f.strategy.id === "city-dev")!;
    const beforeRoll = decideNext({
      tracker: t,
      youName: "Nick",
      fit: cityDev,
      gs,
      advice: null,
      rolledThisTurn: false,
      knightAvailable: true,
      robberHex: { x: myHex.q, y: myHex.r },
    });
    expect(beforeRoll?.kind).toBe("roll"); // don't play the knight yet

    const afterRoll = decideNext({
      tracker: t,
      youName: "Nick",
      fit: cityDev,
      gs,
      advice: null,
      rolledThisTurn: true,
      knightAvailable: true,
      robberHex: { x: myHex.q, y: myHex.r },
    });
    expect(afterRoll?.kind).toBe("play-knight");
  });

  it("won't build an eager road it can't settle the same turn", () => {
    // settlement at V + road V->N so N is in our network; M (N's far neighbour,
    // distance 2 from V) is a legal open spot. The advised road N->M opens M.
    const V = board.vertices.find((v) => v.hexIds.length === 3 && v.adjacent.length === 3)!;
    const N = V.adjacent[0];
    const M = board.vertices[N].adjacent.find(
      (x) => x !== V.id && !board.vertices[V.id].adjacent.includes(x),
    )!;
    const edge = (a: number, b: number) =>
      board.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))!;
    const gs = {
      state: {
        board,
        buildings: [{ vertexId: V.id, player: 0 as const, kind: "settlement" as const }],
        roads: [{ edgeId: edge(V.id, N).id, player: 0 as const }],
      },
      youPlayer: 0 as const,
    };
    const advice = {
      phase: "main" as const,
      heading: "",
      spots: [{ vertexId: M, rank: 1, label: "" }],
      roadEdges: [edge(N, M).id],
      note: null,
    };
    const roadExpand = () =>
      rankLiveStrategies(trackerWith({}), "Nick").find((f) => f.strategy.id === "road-expand")!;

    // Only road resources -> can't also settle this turn -> DON'T build the road.
    const t1 = trackerWith({ wood: 1, brick: 1 }, false);
    const d1 = decideNext({
      tracker: t1, youName: "Nick", fit: roadExpand(), gs, advice, rolledThisTurn: true,
    });
    expect(d1?.kind).not.toBe("build-road");

    // Road + settlement resources -> build the road (settling it right after).
    const t2 = trackerWith({ wood: 2, brick: 2, sheep: 1, wheat: 1 }, false);
    const d2 = decideNext({
      tracker: t2, youName: "Nick", fit: roadExpand(), gs, advice, rolledThisTurn: true,
    });
    expect(d2?.kind).toBe("build-road");
  });

  it("won't trade toward a settlement it has nowhere to place", () => {
    // game-log fix (loss): city resources were 4:1-traded toward settlements
    // with no legal spot and no road path — pure waste. With NO placeable
    // settlement AND no completable city, nothing proactively fires...
    const t = trackerWith({ wheat: 2, wood: 1, brick: 1 }, false);
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: rankLiveStrategies(t, "Nick")[0],
      gs: gsWithSettlement(), // network is just the settlement itself — no spot
      advice: null, // and no advised road path to one
      rolledThisTurn: true,
    });
    expect(d?.kind).toBe("end-turn"); // hold the hand, don't burn it

    // Seven cards are within the limit; preserve wheat for the city.
    const t2 = trackerWith({ wheat: 5, wood: 1, brick: 1 }, false);
    const d2 = decideNext({
      tracker: t2,
      youName: "Nick",
      fit: rankLiveStrategies(t2, "Nick")[0],
      gs: gsWithSettlement(),
      advice: null,
      rolledThisTurn: true,
    });
    expect(d2?.kind).toBe("end-turn");
    expect(d2?.describe).toContain("save for");
  });

  it("trades toward the ROADS + settlement together when the spot needs a road", () => {
    // same shape as the eager-road fixture: best spot M is one road away
    const V = board.vertices.find((v) => v.hexIds.length === 3 && v.adjacent.length === 3)!;
    const N = V.adjacent[0];
    const M = board.vertices[N].adjacent.find(
      (x) => x !== V.id && !board.vertices[V.id].adjacent.includes(x),
    )!;
    const edge = (a: number, b: number) =>
      board.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))!;
    const gs = {
      state: {
        board,
        buildings: [{ vertexId: V.id, player: 0 as const, kind: "settlement" as const }],
        roads: [{ edgeId: edge(V.id, N).id, player: 0 as const }],
      },
      youPlayer: 0 as const,
    };
    const advice = {
      phase: "main" as const,
      heading: "",
      spots: [{ vertexId: M, rank: 1, label: "" }],
      roadEdges: [edge(N, M).id],
      note: null,
    };
    // road + settlement need 2 wood 2 brick 1 sheep 1 wheat; only wheat is
    // missing and the ore surplus covers it -> fund the whole claim via bank.
    const t = trackerWith({ wood: 2, brick: 2, sheep: 1, ore: 4 }, false);
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t, youName: "Nick", fit: fits[0], gs, advice, rolledThisTurn: true,
    });
    expect(d?.kind).toBe("bank-trade");
    expect(d?.trade?.get).toBe("wheat");
    expect(d?.describe).toContain("fund settlement");
  });

  it("claims a spot TWO roads away in one turn when fully funded", () => {
    const V = board.vertices.find((v) => v.hexIds.length === 3 && v.adjacent.length === 3)!;
    const N = V.adjacent[0];
    const M = board.vertices[N].adjacent.find(
      (x) => x !== V.id && !board.vertices[V.id].adjacent.includes(x),
    )!;
    const edge = (a: number, b: number) =>
      board.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))!;
    const gs = {
      state: {
        board,
        buildings: [{ vertexId: V.id, player: 0 as const, kind: "settlement" as const }],
        roads: [],
      },
      youPlayer: 0 as const,
    };
    const advice = {
      phase: "main" as const,
      heading: "",
      spots: [{ vertexId: M, rank: 1, label: "" }],
      roadEdges: [edge(V.id, N).id, edge(N, M).id],
      note: null,
    };
    const fit = () => rankLiveStrategies(trackerWith({}), "Nick")[0];

    // 2 roads + settlement = 3 wood 3 brick 1 sheep 1 wheat: fully funded -> go
    const t1 = trackerWith({ wood: 3, brick: 3, sheep: 1, wheat: 1 }, false);
    const d1 = decideNext({
      tracker: t1, youName: "Nick", fit: fit(), gs, advice, rolledThisTurn: true,
    });
    expect(d1?.kind).toBe("build-road");

    // One road short, but production can fund the rest within the horizon:
    // staging a useful road is productive.
    const t2 = trackerWith({ wood: 2, brick: 2, sheep: 1, wheat: 1 }, false);
    const d2 = decideNext({
      tracker: t2, youName: "Nick", fit: fit(), gs, advice, rolledThisTurn: true,
    });
    expect(d2?.kind).toBe("build-road");
  });

  it("plays Road Building when the advised path claims a spot it can then settle", () => {
    const V = board.vertices.find((v) => v.hexIds.length === 3 && v.adjacent.length === 3)!;
    const N = V.adjacent[0];
    const M = board.vertices[N].adjacent.find(
      (x) => x !== V.id && !board.vertices[V.id].adjacent.includes(x),
    )!;
    const edge = (a: number, b: number) =>
      board.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))!;
    const gs = {
      state: {
        board,
        buildings: [{ vertexId: V.id, player: 0 as const, kind: "settlement" as const }],
        roads: [{ edgeId: edge(V.id, N).id, player: 0 as const }],
      },
      youPlayer: 0 as const,
    };
    const advice = {
      phase: "main" as const,
      heading: "",
      spots: [{ vertexId: M, rank: 1, label: "" }],
      roadEdges: [edge(N, M).id],
      note: null,
    };
    // settlement cost in hand; the card covers the road
    const t = trackerWith({ wood: 1, brick: 1, sheep: 1, wheat: 1 }, false);
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t, youName: "Nick", fit: fits[0], gs, advice, rolledThisTurn: true,
      hasRoadBuilding: true,
    });
    expect(d?.kind).toBe("play-road-building");

    // The shared planner finds a route even without overlay advice.
    const d2 = decideNext({
      tracker: t, youName: "Nick", fit: fits[0], gs, advice: null, rolledThisTurn: true,
      hasRoadBuilding: true,
    });
    expect(d2?.kind).toBe("play-road-building");

    // a FAR target (3 roads, no same-turn claim possible) still plays it:
    // retain it when the unfunded target does not beat saving for a city.
    const far = { ...advice, roadPathLength: 3 };
    const d3 = decideNext({
      tracker: trackerWith({}, false), youName: "Nick", fit: fits[0], gs, advice: far, rolledThisTurn: true,
      hasRoadBuilding: true,
    });
    expect(d3?.kind).toBe("end-turn");
  });

  it("places the owed free roads after Road Building, along the advised path", () => {
    const V = board.vertices.find((v) => v.hexIds.length === 3 && v.adjacent.length === 3)!;
    const N = V.adjacent[0];
    const M = board.vertices[N].adjacent.find(
      (x) => x !== V.id && !board.vertices[V.id].adjacent.includes(x),
    )!;
    const edge = (a: number, b: number) =>
      board.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))!;
    const gs = {
      state: {
        board,
        buildings: [{ vertexId: V.id, player: 0 as const, kind: "settlement" as const }],
        roads: [{ edgeId: edge(V.id, N).id, player: 0 as const }],
      },
      youPlayer: 0 as const,
    };
    const advice = {
      phase: "main" as const,
      heading: "",
      spots: [{ vertexId: M, rank: 1, label: "" }],
      roadEdges: [edge(N, M).id],
      note: null,
    };
    const t = trackerWith({}, false); // free roads need no resources
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t, youName: "Nick", fit: fits[0], gs, advice, rolledThisTurn: true,
      freeRoadsPending: 2,
    });
    expect(d?.kind).toBe("build-road");
    expect(d?.free).toBe(true);

    // no advice at all -> still places (the game is blocked): best network edge
    const d2 = decideNext({
      tracker: t, youName: "Nick", fit: fits[0], gs, advice: null, rolledThisTurn: true,
      freeRoadsPending: 1,
    });
    expect(d2?.kind).toBe("build-road");
    expect(d2?.free).toBe(true);
  });

  it("plays Year of Plenty for exactly the two cards that complete a city", () => {
    const t = trackerWith({ ore: 2, wheat: 1 }, false); // city needs 3 ore 2 wheat
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t, youName: "Nick", fit: fits[0], gs: gsWithSettlement(), advice: null,
      rolledThisTurn: true, hasYearOfPlenty: true,
    });
    expect(d?.kind).toBe("play-year-of-plenty");
    expect([...(d?.resources ?? [])].sort()).toEqual(["ore", "wheat"]);
    expect(d?.describe).toContain("city");
  });

  it("in the endgame plays Year of Plenty toward the cheapest VP build even if it can't finish it", () => {
    const t = trackerWith({ ore: 1 }, false); // city is 4 cards away
    t.players.get("Nick")!.serverVp = 8; // 10-point game, within 3 of the target
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t, youName: "Nick", fit: fits[0], gs: gsWithSettlement(), advice: null,
      rolledThisTurn: true, hasYearOfPlenty: true,
    });
    expect(d?.kind).toBe("play-year-of-plenty");
    expect(d?.resources?.every((r) => r === "ore" || r === "wheat")).toBe(true);
  });

  it("stages a selected expansion without a road-count cutoff", () => {
    const V = board.vertices.find((v) => v.hexIds.length === 3 && v.adjacent.length === 3)!;
    const N = V.adjacent[0];
    const M = board.vertices[N].adjacent.find((x) => x !== V.id && !V.adjacent.includes(x))!;
    const [O, P] = board.vertices[M].adjacent.filter((x) => x !== N);
    const edge = (a: number, b: number) =>
      board.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))!;
    // 1 building, 4 roads already (>= buildings + 3) -> bloated
    const extra = board.edges.filter((e) => e.a !== V.id && e.b !== V.id && e.a !== N && e.b !== N).slice(0, 4);
    const gs = {
      state: {
        board,
        buildings: [
          { vertexId: V.id, player: 0 as const, kind: "settlement" as const },
          { vertexId: O, player: 1 as const, kind: "settlement" as const },
        ],
        roads: extra.map((e) => ({ edgeId: e.id, player: 0 as const })),
      },
      youPlayer: 0 as const,
    };
    const advice = { phase: "main" as const, heading: "", spots: [{ vertexId: P, rank: 1, label: "" }],
      roadEdges: [edge(V.id, N).id, edge(N, M).id], roadPathLength: 3, note: null };
    const t = trackerWith({ wood: 3, brick: 3, sheep: 3 }, false); // 9 cards: at the limit
    const d = decideNext({ tracker: t, youName: "Nick", fit: rankLiveStrategies(t, "Nick")[0], gs, advice, rolledThisTurn: true });
    expect(d?.kind).toBe("build-road");
    expect(d?.describe).toContain("planned");
  });

  it("uses Year of Plenty when it accelerates the best investment", () => {
    const t = trackerWith({}, false); // empty hand: everything is 4+ cards away
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t, youName: "Nick", fit: fits[0], gs: gsWithSettlement(), advice: null,
      rolledThisTurn: true, hasYearOfPlenty: true,
    });
    expect(d?.kind).toBe("play-year-of-plenty");
  });

    it("does NOT feed roads into a race the opponent reaches first", async () => {
    // Same geometry but an opponent sits next to M: they need 2 roads to P
    // vs our 3 (play-feedback loss: we committed roads, they connected first).
    const { spotContest } = await import("./placement");
    const V = board.vertices.find((v) => v.hexIds.length === 3 && v.adjacent.length === 3)!;
    const N = V.adjacent[0];
    const M = board.vertices[N].adjacent.find(
      (x) => x !== V.id && !board.vertices[V.id].adjacent.includes(x),
    )!;
    const [O, P] = board.vertices[M].adjacent.filter((x) => x !== N);
    const edge = (a: number, b: number) =>
      board.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))!;
    const gs = {
      state: {
        board,
        buildings: [
          { vertexId: V.id, player: 0 as const, kind: "settlement" as const },
          { vertexId: O, player: 1 as const, kind: "settlement" as const },
        ],
        roads: [],
      },
      youPlayer: 0 as const,
    };
    // contest math: us 3 roads, them 2 — strictly behind
    const c = spotContest(gs.state, 0, P);
    expect(c.ourLen).toBe(3);
    expect(c.oppLen).toBe(2);
    expect(c.losing).toBe(true);

    const advice = {
      phase: "main" as const,
      heading: "",
      spots: [{ vertexId: P, rank: 1, label: "" }],
      roadEdges: [edge(V.id, N).id, edge(N, M).id],
      roadPathLength: 3,
      note: null,
    };
    const fit = () => rankLiveStrategies(trackerWith({}), "Nick")[0];

    // surplus road resources are NOT dumped into the lost race...
    const d1 = decideNext({
      tracker: trackerWith({ wood: 2, brick: 2 }, false), youName: "Nick", fit: fit(),
      gs, advice, rolledThisTurn: true,
    });
    expect(d1?.kind).not.toBe("build-road");

    // only the settlement's worth (2+2) -> keep it for the claim, don't spend it
    const d2 = decideNext({
      tracker: trackerWith({ wood: 2, brick: 2 }, false), youName: "Nick", fit: fit(),
      gs, advice, rolledThisTurn: true,
    });
    expect(d2?.kind).toBe("end-turn");

    // ...and neither does a 7-due dump convert into a doomed road.
    const d3 = decideNext({
      tracker: trackerWith({ wood: 1, brick: 1, sheep: 6 }, false), youName: "Nick", fit: fit(),
      gs, advice, rolledThisTurn: true,
    });
    expect(d3?.kind).not.toBe("build-road");
  });

  it("compares a productive city against adding resource coverage", () => {
    // A high-pip settlement to upgrade + a low-pip open spot on our network:
    // prefer the city (doubles our best producer) over a marginal settlement.
    const strong = board.vertices.find((v) => v.hexIds.length === 3 && v.adjacent.length === 3)!;
    // a buildable neighbour-of-neighbour spot reachable via one road
    const N = strong.adjacent[0];
    const M = board.vertices[N].adjacent.find((x) => x !== strong.id && !strong.adjacent.includes(x))!;
    const edge = (a: number, b: number) =>
      board.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))!;
    // only assert when the strong corner really out-produces the reachable spot
    if (vertexPips(board, strong.id) < vertexPips(board, M) + 2) return;
    const gs = {
      state: {
        board,
        buildings: [{ vertexId: strong.id, player: 0 as const, kind: "settlement" as const }],
        roads: [{ edgeId: edge(strong.id, N).id, player: 0 as const }, { edgeId: edge(N, M).id, player: 0 as const }],
      },
      youPlayer: 0 as const,
    };
    // enough for a city (3 ore 2 wheat) OR a settlement (1 each) — city wins
    const t = trackerWith({ ore: 3, wheat: 2, wood: 1, brick: 1, sheep: 1 }, false);
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t, youName: "Nick", fit: fits[0], gs, advice: null, rolledThisTurn: true,
    });
    expect(d?.kind).toBe("build-city");
    expect(board.vertices[M].hexIds.some((id) => board.hexes[id].kind === "wheat")).toBe(true);
  });

  it("accepts holding risk when a dev purchase would burn six cards in conversions", () => {
    // Buying a dev via two 4:1 trades loses six cards to conversion alone.
    // At ordinary deck exposure, that certainty costs more than holding.
    const t = trackerWith({ wood: 6, sheep: 5 }, false);
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t, youName: "Nick", fit: fits[0], gs: gsWithSettlement(), advice: null, rolledThisTurn: true,
    });
    expect(d?.kind).toBe("end-turn");
    expect(d?.describe).toContain("reward outweighs spending now");
  });

  it("endgame steering: builds the win-model's step first", () => {
    // can afford BOTH a city and a settlement; strategy order would settle
    // first, but the path-to-victory says city -> city
    const V = board.vertices.find((v) => v.hexIds.length === 3 && v.adjacent.length === 3)!;
    const N = V.adjacent[0];
    const M = board.vertices[N].adjacent.find((x) => x !== V.id && !V.adjacent.includes(x))!;
    const edge = (a: number, b: number) =>
      board.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))!;
    const gs = { state: { board, buildings: [{ vertexId: V.id, player: 0 as const, kind: "settlement" as const }],
      roads: [{ edgeId: edge(V.id, N).id, player: 0 as const }, { edgeId: edge(N, M).id, player: 0 as const }] }, youPlayer: 0 as const };
    const t = trackerWith({ ore: 3, wheat: 3, wood: 1, brick: 1, sheep: 1 }, false);
    t.players.get("Nick")!.serverVp = 13;
    const fit = rankLiveStrategies(t, "Nick").find((f) => f.strategy.id === "road-expand")!;
    const d = decideNext({ tracker: t, youName: "Nick", fit, gs, advice: null, rolledThisTurn: true, winTarget: 15 });
    expect(d?.kind).toBe("build-city");
  });



  it("VP cards reduce the actual gap without a phase threshold", () => {
    // 11 public + 2 VP cards = 13 of 15 -> endgame: trade toward the step at any hand size
    const t = trackerWith({ wood: 6 }, false);
    t.players.get("Nick")!.serverVp = 11;
    const fits = rankLiveStrategies(t, "Nick");
    const noCards = decideNext({ tracker: t, youName: "Nick", fit: fits[0], gs: gsWithSettlement(), advice: null, rolledThisTurn: true, winTarget: 15 });
    expect(noCards?.evaluation?.gap).toBe(4);
    const withCards = decideNext({ tracker: t, youName: "Nick", fit: fits[0], gs: gsWithSettlement(), advice: null, rolledThisTurn: true, winTarget: 15, vpCardsHeld: 2 });
    expect(withCards?.evaluation?.gap).toBe(2);
    expect(withCards?.evaluation?.horizon).toBeLessThan(noCards!.evaluation!.horizon);
  });

  it("won't trade toward a city when it has no settlement to upgrade", () => {
    const v = board.vertices.find((x) => x.hexIds.length === 3)!;
    const gs = {
      state: {
        board,
        buildings: [{ vertexId: v.id, player: 0 as const, kind: "city" as const }],
        roads: [],
      },
      youPlayer: 0 as const,
    };
    const t = trackerWith({ ore: 3, wheat: 1, wood: 4 }, false);
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t, youName: "Nick", fit: fits[0], gs, advice: null, rolledThisTurn: true,
    });
    expect(d?.evaluation?.alternatives.some((b) => b.kind === "city")).toBe(false); // not a 4:1 wood dump toward an impossible city
  });

  it("prefers a placeable settlement over a dev card in the endgame", () => {
    // game-log fix (loss at 8 VP with 11 cards in hand): post-growth the plan
    // kept buying dev cards; a placeable settlement is a guaranteed point.
    const V = board.vertices.find((v) => v.hexIds.length === 3 && v.adjacent.length === 3)!;
    const N = V.adjacent[0];
    const M = board.vertices[N].adjacent.find(
      (x) => x !== V.id && !board.vertices[V.id].adjacent.includes(x),
    )!;
    const edge = (a: number, b: number) =>
      board.edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))!;
    const gs = {
      state: {
        board,
        buildings: [{ vertexId: V.id, player: 0 as const, kind: "settlement" as const }],
        roads: [
          { edgeId: edge(V.id, N).id, player: 0 as const },
          { edgeId: edge(N, M).id, player: 0 as const },
        ],
      },
      youPlayer: 0 as const,
    };
    const t = trackerWith({ wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 1 }, false);
    t.players.get("Nick")!.serverVp = 8; // endgame: past the growth phase
    const fits = rankLiveStrategies(t, "Nick");
    const cityDev = fits.find((f) => f.strategy.id === "city-dev")!;
    const d = decideNext({
      tracker: t, youName: "Nick", fit: cityDev, gs, advice: null, rolledThisTurn: true,
    });
    expect(d?.kind).toBe("build-settlement"); // NOT buy-dev, though dev is affordable
  });

  it("requires exact holdings instead of extrapolating ten ore from two observed", () => {
    // opponent produces heavily from ore tiles -> they hoard ore -> take ore,
    // even though our own shortfall might be a different resource.
    const t = trackerWith({ wheat: 2 }, false);
    applyEvent(t, { type: "roll", player: "Ava", total: 8 });
    applyEvent(t, { type: "got", player: "Ava", resources: { ore: 2 } }); // Ava's income = ore
    t.players.get("Ava")!.serverCards = 10; // card-rich
    const fits = rankLiveStrategies(t, "Nick");
    const cityDev = fits.find((f) => f.strategy.id === "city-dev")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: cityDev,
      gs: gsWithSettlement(),
      advice: null,
      rolledThisTurn: true,
      hasMonopoly: true,
    });
    expect(d?.kind).not.toBe("play-monopoly");
    expect(t.players.get("Ava")!.trackingHealth).not.toBe("exact");
  });

  it("does not play a monopoly when opponents hold few cards", () => {
    const t = trackerWith({ wheat: 2 }, false);
    applyEvent(t, { type: "roll", player: "Ava", total: 8 });
    applyEvent(t, { type: "got", player: "Ava", resources: { ore: 1 } });
    t.players.get("Ava")!.serverCards = 3; // opponent nearly empty (< 5)
    const fits = rankLiveStrategies(t, "Nick");
    const cityDev = fits.find((f) => f.strategy.id === "city-dev")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: cityDev,
      gs: gsWithSettlement(),
      advice: null,
      rolledThisTurn: true,
      hasMonopoly: true,
    });
    expect(d?.kind).not.toBe("play-monopoly");
  });

  it("does not build a settlement when none are left in supply", () => {
    const t = trackerWith({ wood: 1, brick: 1, sheep: 1, wheat: 1 }); // can afford
    const fits = rankLiveStrategies(t, "Nick");
    const gs = gsWithSettlement();
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: fits.find((f) => f.strategy.id === "road-expand")!,
      gs,
      advice: null,
      rolledThisTurn: true,
      piecesLeft: { settlements: 0, cities: 4, roads: 15 }, // out of settlements
    });
    expect(d?.kind).not.toBe("build-settlement");
  });

  it("does not build a city when none are left in supply", () => {
    const t = trackerWith({ ore: 3, wheat: 2 }); // can afford a city
    const fits = rankLiveStrategies(t, "Nick");
    const gs = gsWithSettlement(); // has a settlement to upgrade
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: fits.find((f) => f.strategy.id === "city-dev")!,
      gs,
      advice: null,
      rolledThisTurn: true,
      piecesLeft: { settlements: 5, cities: 0, roads: 15 }, // out of cities
    });
    expect(d?.kind).not.toBe("build-city");
  });

  it("does not bank-trade toward a dev card when the bank is sold out", () => {
    // 8 ore, city-dev wants dev (ore+sheep+wheat); with dev sold out it must
    // not trade ore toward the (impossible) dev buy — end the turn instead.
    const t = trackerWith({ ore: 8 }, false);
    t.players.get("Nick")!.serverVp = 8; // late phase where dev is in the plan
    const fits = rankLiveStrategies(t, "Nick");
    const cityDev = fits.find((f) => f.strategy.id === "city-dev")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: cityDev,
      gs: null, // no board: city can't be placed either
      advice: null,
      rolledThisTurn: true,
      bankDevCards: 0,
    });
    expect(d?.kind).not.toBe("bank-trade");
  });

  it("falls back to clicking game buttons when no template is learned", () => {
    localStorage.clear();
    const learner = new ProtocolLearner(); // nothing learned
    const clicks: string[] = [];
    const ap = new Autopilot(learner, () => false, (kind) => {
      clicks.push(kind);
      return "clicked";
    });
    ap.setEnabled(true);
    ap.noteDomTurn(true); // DOM banner says it's my turn; not rolled yet

    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    ap.tick({ tracker: t, gs: null, advice: null, fit: fits[0], now: 10_000 });
    expect(clicks).toEqual(["roll"]);
  });

  it("opens the turn gate from the DOM banner even when WS color never matches", () => {
    localStorage.clear();
    const learner = new ProtocolLearner();
    const clicks: string[] = [];
    const ap = new Autopilot(learner, () => false, (kind) => {
      clicks.push(kind);
      return "clicked";
    });
    ap.setEnabled(true);
    // WebSocket turn frames arrive but the color never equals ours (mismatch
    // or myColor null) — the WS signal stays false...
    ap.onTurnState(2, 5);
    ap.onTurnState(3, 5);
    // ...yet the "Your Turn" banner is up, so autopilot must still act.
    ap.noteDomTurn(true);
    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    ap.tick({ tracker: t, gs: null, advice: null, fit: fits[0], now: 10_000 });
    expect(clicks).toEqual(["roll"]);
  });

  it("rolls once our color resolves late, even mid-turn (no banner)", () => {
    localStorage.clear();
    const learner = new ProtocolLearner();
    const clicks: string[] = [];
    const ap = new Autopilot(learner, () => false, (kind) => {
      clicks.push(kind);
      return "clicked";
    });
    ap.setEnabled(true);
    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    const ctx = { tracker: t, gs: null, advice: null, fit: fits[0] };

    // Turn frame says it's color 3's turn, but our color hasn't resolved yet.
    ap.onTurnState(3, null);
    ap.noteDomTurn(false);
    ap.tick({ ...ctx, now: 10_000 });
    expect(clicks).toEqual([]); // can't tell it's us — wait

    // Roster resolves our color to 3 (re-evaluated with the same turn color).
    ap.onTurnState(3, 3);
    ap.tick({ ...ctx, now: 11_000 });
    expect(clicks).toEqual(["roll"]); // now it rolls, without a banner
  });

  it("does not act when neither turn signal fires", () => {
    localStorage.clear();
    const learner = new ProtocolLearner();
    const clicks: string[] = [];
    const ap = new Autopilot(learner, () => false, (kind) => {
      clicks.push(kind);
      return "clicked";
    });
    ap.setEnabled(true);
    ap.onTurnState(2, 5); // WS: not mine
    ap.noteDomTurn(false); // DOM: no banner
    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    ap.tick({ tracker: t, gs: null, advice: null, fit: fits[0], now: 10_000 });
    expect(clicks).toEqual([]);
  });

  it("syncs the exact own hand from server player-state frames", () => {
    const t = trackerWith({ wood: 1, sheep: 3 }); // log-derived, missing an ore
    applyServerPlayerState(
      t,
      [
        // 1 wood, 3 sheep, 1 ore — colonist card ids
        { username: "Nick", color: 3, resourceCards: [1, 3, 3, 3, 5] },
        { username: "Ava", color: 1, resourceCards: [0, 0, 0, 0, 0, 0, 0] },
      ],
      3,
    );
    const nick = t.players.get("Nick")!;
    expect(nick.hand).toEqual({ wood: 1, brick: 0, sheep: 3, wheat: 0, ore: 1 });
    expect(nick.uncertainty).toBe(0);
    expect(nick.serverCards).toBe(5);
    // opponent cards are masked (ids 0) — total is authoritative, mix unknown
    const ava = t.players.get("Ava")!;
    expect(ava.serverCards).toBe(7);
  });

  it("plays a knight when the robber squats on your tile", () => {
    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    const gs = gsWithSettlement();
    const myHex = board.hexes[board.vertices[gs.state.buildings[0].vertexId].hexIds[0]];
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: fits[0],
      gs,
      advice: null,
      rolledThisTurn: true,
      robberHex: { x: myHex.q, y: myHex.r },
      knightAvailable: true,
    });
    expect(d?.kind).toBe("play-knight");
    expect(d?.describe).toContain("robber is on your tile");
  });

  it("chases Largest Army only when it would WIN, on any plan", () => {
    const t = trackerWith({});
    const nick = t.players.get("Nick")!;
    nick.serverVp = 8; // LA (+2) reaches 10 — decisive
    nick.knightsPlayed = 2; // one more knight takes (or ties for) the army
    applyEvent(t, { type: "place", player: "Ava", color: "#E27174", what: "settlement" });
    t.players.get("Ava")!.knightsPlayed = 1;
    const fits = rankLiveStrategies(t, "Nick");
    const cityDev = fits.find((f) => f.strategy.id === "city-dev")!;
    const roadExpand = fits.find((f) => f.strategy.id === "road-expand")!;
    const base = {
      tracker: t,
      youName: "Nick",
      gs: gsWithSettlement(),
      advice: null,
      rolledThisTurn: true,
      robberHex: { x: 99, y: 99 }, // robber on nobody
      knightAvailable: true,
    };
    expect(decideNext({ ...base, fit: cityDev })?.kind).toBe("play-knight");
    expect(decideNext({ ...base, fit: roadExpand })?.kind).toBe("play-knight");
  });



  it("does not let generic dev-card count trigger early army chasing", () => {
    const t = trackerWith({});
    applyEvent(t, { type: "place", player: "Ava", color: "#E27174", what: "settlement" });
    const you = t.players.get("Nick")!;
    you.devCards = 4;
    you.knightsPlayed = 0; // 4 unplayed dev cards → play aggressively
    t.players.get("Nick")!.knightsPlayed = 2;
    const fits = rankLiveStrategies(t, "Nick");
    const base = {
      tracker: t,
      youName: "Nick",
      gs: gsWithSettlement(),
      advice: null,
      rolledThisTurn: true,
      robberHex: { x: 99, y: 99 },
      knightAvailable: true,
    };
    const d = decideNext({ ...base, fit: fits[0] });
    expect(d?.kind).not.toBe("play-knight");
  });



  it("executor plays a learned knight once per turn and not the turn it's bought", () => {
    localStorage.clear();
    const learner = new ProtocolLearner();
    learner.recordOutbound({ id: 9, data: { type: 60, payload: { cardType: 7 } } }, 1000);
    learner.confirm("play-knight", 1200);

    const sent: Array<{ kind: string }> = [];
    const ap = new Autopilot(learner, (d) => {
      sent.push(d as { kind: string });
      return true;
    });
    const knights = () => sent.filter((d) => d.kind === "play-knight").length;
    ap.setEnabled(true);
    ap.onTurnState(3, 3); // my turn
    ap.onYouRolled();

    const t = trackerWith({});
    const cityDev = rankLiveStrategies(t, "Nick").find((f) => f.strategy.id === "city-dev")!;
    const gs = gsWithSettlement();
    const myHex = board.hexes[board.vertices[gs.state.buildings[0].vertexId].hexIds[0]];
    const ctx = {
      tracker: t,
      gs,
      advice: null,
      fit: cityDev,
      knightsInHand: 2,
      robberHex: { x: myHex.q, y: myHex.r }, // blocked — win-critical knight use
      now: 10_000,
    };
    ap.tick(ctx);
    expect(knights()).toBe(1); // knight played

    ap.onConfirm("play-knight"); // game confirmed: one dev per turn is spent
    ap.tick({ ...ctx, now: 12_000 });
    expect(knights()).toBe(1); // no second knight this turn

    // next turn, but the only knight in hand was bought this turn
    ap.onTurnState(1, 3);
    ap.onTurnState(3, 3);
    ap.onYouRolled();
    ap.onConfirm("buy-dev");
    ap.tick({ ...ctx, knightsInHand: 1, now: 20_000 });
    expect(knights()).toBe(1); // still just the one knight
  });

  it("picks a robber tile that hurts the opponent, not itself", () => {
    // opponent settlement on a 3-hex vertex; my settlement elsewhere
    const oppVertex = board.vertices.find((v) => v.hexIds.length === 3)!;
    const myVertex = board.vertices.find(
      (v) => v.hexIds.length === 3 && !v.hexIds.some((h) => oppVertex.hexIds.includes(h)),
    )!;
    const state: GameState = {
      board,
      buildings: [
        { vertexId: oppVertex.id, player: 1, kind: "settlement" },
        { vertexId: myVertex.id, player: 0, kind: "settlement" },
      ],
      roads: [],
    };
    const target = bestRobberHex(state, 0, null)!;
    expect(target).not.toBeNull();
    // the chosen tile must be one the opponent touches
    const hex = board.hexes.find((h) => h.q === target.hex.x && h.r === target.hex.y)!;
    const oppTouches = oppVertex.hexIds.includes(hex.id);
    const iTouch = myVertex.hexIds.includes(hex.id);
    expect(oppTouches).toBe(true);
    expect(iTouch).toBe(false);
    expect(target.victim).toBe(1);
  });

  it("friendly robber: won't pick a tile whose only victim is under 3 VP", () => {
    const oppVertex = board.vertices.find((v) => v.hexIds.length === 3)!;
    const state: GameState = {
      board,
      buildings: [{ vertexId: oppVertex.id, player: 1, kind: "settlement" }],
      roads: [],
    };
    // opponent (player 1) is NOT robbable -> no tile they touch is legal
    const canRob = (p: number) => p !== 1;
    const target = bestRobberHex(state, 0, null, canRob);
    expect(target).not.toBeNull();
    // the chosen tile must touch no un-robbable opponent, and steal from no one
    const hex = board.hexes.find((h) => h.q === target!.hex.x && h.r === target!.hex.y)!;
    expect(oppVertex.hexIds.includes(hex.id)).toBe(false);
    expect(target!.victim).toBeNull();
  });

  it("friendly robber: still robs an opponent once they reach 3 VP", () => {
    const oppVertex = board.vertices.find((v) => v.hexIds.length === 3)!;
    const state: GameState = {
      board,
      buildings: [{ vertexId: oppVertex.id, player: 1, kind: "settlement" }],
      roads: [],
    };
    const target = bestRobberHex(state, 0, null, () => true); // everyone robbable
    expect(target!.victim).toBe(1);
    const hex = board.hexes.find((h) => h.q === target!.hex.x && h.r === target!.hex.y)!;
    expect(oppVertex.hexIds.includes(hex.id)).toBe(true);
  });

  it("never re-places the robber on its current tile", () => {
    const oppVertex = board.vertices.find((v) => v.hexIds.length === 3)!;
    const state: GameState = {
      board,
      buildings: [{ vertexId: oppVertex.id, player: 1, kind: "settlement" }],
      roads: [],
    };
    const first = bestRobberHex(state, 0, null)!;
    const again = bestRobberHex(state, 0, first.hex);
    if (again) {
      expect(`${again.hex.x},${again.hex.y}`).not.toBe(`${first.hex.x},${first.hex.y}`);
    }
  });

  it("prioritizes moving the robber over building when pending", () => {
    const oppVertex = board.vertices.find((v) => v.hexIds.length === 3)!;
    const gs = {
      state: {
        board,
        buildings: [
          { vertexId: oppVertex.id, player: 1 as const, kind: "settlement" as const },
        ],
        roads: [],
      },
      youPlayer: 0 as const,
    };
    const t = trackerWith({ ore: 3, wheat: 2 }); // could afford a city
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: fits[0],
      gs,
      advice: null,
      rolledThisTurn: true,
      robberPending: true,
      robberHex: null,
    });
    expect(d?.kind).toBe("move-robber");
    expect(d?.coord).toBeDefined();
    expect(d?.coord?.z).toBeUndefined(); // hexFace has no z
  });

  it("learns and rebuilds a move-robber (hexFace) template", () => {
    localStorage.clear();
    const learner = new ProtocolLearner();
    learner.recordOutbound(
      { id: 5, data: { type: 40, payload: { hexFace: { x: 1, y: -1 } } } },
      1000,
    );
    learner.confirm("move-robber", 1500);
    expect(learner.status()["move-robber"]).toBe(true);
    const frame = learner.buildFrame("move-robber", { x: -2, y: 2 }) as {
      data: { payload: { hexFace: { x: number; y: number; z?: number } } };
    };
    expect(frame.data.payload.hexFace).toEqual({ x: -2, y: 2 });
    expect("z" in frame.data.payload.hexFace).toBe(false);
  });

  it("moves the robber via the learned template when it's yours to move", () => {
    localStorage.clear();
    const learner = new ProtocolLearner();
    learner.recordOutbound(
      { id: 5, data: { type: 40, payload: { hexFace: { x: 1, y: -1 } } } },
      1000,
    );
    learner.confirm("move-robber", 1500);

    const sent: unknown[] = [];
    const ap = new Autopilot(learner, (d) => { sent.push(d); return true; });
    ap.setEnabled(true);
    ap.onTurnState(3, 3); // my turn (WS)
    ap.setRobberPending(true);

    const oppVertex = board.vertices.find((v) => v.hexIds.length === 3)!;
    const gs = {
      state: {
        board,
        buildings: [
          { vertexId: oppVertex.id, player: 1 as const, kind: "settlement" as const },
        ],
        roads: [],
      },
      youPlayer: 0 as const,
    };
    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    ap.tick({ tracker: t, gs, advice: null, fit: fits[0], robberHex: null, now: 10_000 });
    expect(sent).toHaveLength(1);
    const decision = sent[0] as { kind: string; coord: { x: number; y: number } };
    expect(decision.kind).toBe("move-robber");
    // the chosen tile is one the opponent's settlement touches
    const hex = board.hexes.find((h) => h.q === decision.coord.x && h.r === decision.coord.y)!;
    expect(oppVertex.hexIds).toContain(hex.id);
    ap.onConfirm("move-robber");
    expect(ap.robberPending).toBe(false);
  });

  it("never moves the robber out of turn (stray banner match)", () => {
    localStorage.clear();
    const learner = new ProtocolLearner();
    learner.recordOutbound(
      { id: 5, data: { type: 40, payload: { hexFace: { x: 1, y: -1 } } } },
      1000,
    );
    learner.confirm("move-robber", 1500);

    const sent: unknown[] = [];
    const ap = new Autopilot(learner, (d) => { sent.push(d); return true; });
    ap.setEnabled(true);
    ap.onTurnState(1, 3); // WS says it's the OPPONENT's turn
    ap.setRobberPending(true); // banner matched anyway (e.g. false positive)

    const oppVertex = board.vertices.find((v) => v.hexIds.length === 3)!;
    const gs = {
      state: {
        board,
        buildings: [
          { vertexId: oppVertex.id, player: 1 as const, kind: "settlement" as const },
        ],
        roads: [],
      },
      youPlayer: 0 as const,
    };
    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    ap.tick({ tracker: t, gs, advice: null, fit: fits[0], robberHex: null, now: 10_000 });
    expect(sent).toHaveLength(0); // out of turn — nothing sent, template kept
    expect(learner.status()["move-robber"]).toBe(true);
  });

  it("executor sends learned frames and self-corrects on no confirmation", () => {
    localStorage.clear();
    const learner = new ProtocolLearner();
    learner.recordOutbound({ id: 1, data: { type: 7 } }, 1000);
    learner.confirm("roll", 1200);

    const sent: unknown[] = [];
    const ap = new Autopilot(learner, (d) => { sent.push(d); return true; });
    ap.setEnabled(true);
    ap.onTurnState(3, 3); // my turn

    const t = trackerWith({});
    const fits = rankLiveStrategies(t, "Nick");
    const ctx = { tracker: t, gs: gsWithSettlement(), advice: null, fit: fits[0], now: 10_000 };
    ap.tick(ctx);
    expect(sent).toHaveLength(1); // rolled

    // no confirmation arrives: after the timeout the template is discarded
    ap.tick({ ...ctx, now: 20_000 });
    expect(learner.status().roll).toBe(false);
    expect(ap.enabled).toBe(true); // stays on, waits to re-learn
  });
});

describe("trade offers (executor)", () => {
  it("answers an offer off-turn, once, through the dispatcher", () => {
    const sent: Array<{ kind: string; accept?: boolean; tradeId?: string }> = [];
    const ap = new Autopilot(new ProtocolLearner(), (d) => (sent.push({ kind: d.kind, accept: d.accept, tradeId: d.tradeId }), true));
    ap.setEnabled(true);
    const t = trackerWith({ sheep: 3, wheat: 1, brick: 1 }, false); // growth phase: saving for a settlement, short wood
    const fit = rankLiveStrategies(t, "Nick")[0];
    const offers = [{ id: "ab12", creator: 2, offered: { wood: 1 }, wanted: { sheep: 1 } }];
    // NOT our turn: no turn signal at all, still answered
    ap.tick({ tracker: t, gs: gsWithSettlement(), advice: null, fit, tradeOffers: offers, now: 1000 });
    expect(sent).toEqual([{ kind: "trade-response", accept: true, tradeId: "ab12" }]);
    ap.tick({ tracker: t, gs: gsWithSettlement(), advice: null, fit, tradeOffers: offers, now: 2500 });
    expect(sent).toHaveLength(1); // same offer is never answered twice
    // a bad offer is declined (still answered — never leave the table waiting)
    ap.tick({ tracker: t, gs: gsWithSettlement(), advice: null, fit,
      tradeOffers: [{ id: "cd34", creator: 3, offered: { sheep: 1 }, wanted: { wheat: 2 } }], now: 4000 });
    expect(sent[1]).toEqual({ kind: "trade-response", accept: false, tradeId: "cd34" });
  });
});

describe("forced discards", () => {
  beforeEach(() => localStorage.clear());

  it("discard banner matches prompts addressed to you only", () => {
    for (const s of [
      "Select cards to discard",
      "Choose resources to discard",
      "Discard 5 cards",
      "Discard resources",
    ]) {
      expect(DISCARD_BANNER.test(s), s).toBe(true);
    }
    for (const s of [
      "Waiting for Ava to discard",
      "Nick discarded",
      "Discard limit: 9",
      "discard",
    ]) {
      expect(DISCARD_BANNER.test(s), s).toBe(false);
    }
  });

  it("finds a custom discard limit in a settings frame", () => {
    expect(findDiscardLimit({ data: { gameSettings: { cardDiscardLimit: 7 } } })).toBe(7);
    expect(findDiscardLimit({ data: { victoryPointsToWin: 15 } })).toBeNull();
  });

  it("learns a discard template and substitutes the chosen card ids", () => {
    const learner = new ProtocolLearner();
    learner.recordOutbound({ id: 3, data: { type: 60, payload: { selectedCards: [1, 1, 2] } } }, 1000);
    learner.confirm("discard", 1500);
    expect(learner.status().discard).toBe(true);
    const frame = learner.buildFrame("discard", undefined, [3, 3, 5]) as {
      data: { payload: { selectedCards: number[] } };
    };
    expect(frame.data.payload.selectedCards).toEqual([3, 3, 5]);
  });

  it("chooses the worst cards, half the hand, keeping the next build", () => {
    const t = trackerWith({ sheep: 5, ore: 3, wheat: 2 }); // 10 cards > limit 9
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: fits[0],
      gs: null,
      advice: null,
      rolledThisTurn: true,
      discardPending: true,
    });
    expect(d?.kind).toBe("discard");
    const total = Object.values(d!.cards!).reduce((s, n) => s + (n ?? 0), 0);
    expect(total).toBe(5); // floor(10 / 2)
    // sheep is the surplus for every strategy's next build here
    expect(d!.cards!.sheep ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("does not discard when the hand is within the limit", () => {
    const t = trackerWith({ sheep: 3, ore: 3, wheat: 2 }); // 8 cards ≤ 9
    const fits = rankLiveStrategies(t, "Nick");
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: fits[0],
      gs: null,
      advice: null,
      rolledThisTurn: true,
      discardPending: true,
    });
    expect(d?.kind).not.toBe("discard");
  });

  it("dispatches a discard decision even off-turn (a 7 while over the limit)", () => {
    const learner = new ProtocolLearner();
    const sent: Array<{ kind: string; cards?: Record<string, number> }> = [];
    const ap = new Autopilot(learner, (d) => {
      sent.push(d as { kind: string; cards?: Record<string, number> });
      return true;
    });
    ap.setEnabled(true);
    ap.onTurnState(1, 3); // the OPPONENT's turn — their 7 still makes us discard
    ap.setDiscardPending(true);

    const t = trackerWith({ sheep: 6, ore: 2, wheat: 2 }); // 10 cards
    const fits = rankLiveStrategies(t, "Nick");
    ap.tick({ tracker: t, gs: null, advice: null, fit: fits[0], now: 10_000 });
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("discard");
    const total = Object.values(sent[0].cards ?? {}).reduce((s, n) => s + n, 0);
    expect(total).toBe(5); // half of 10, rounded down
    ap.onConfirm("discard");
    expect(ap.discardPending).toBe(false);
  });

  it("does not trade solely to reduce an over-limit hand", () => {
    const t = trackerWith({ wood: 4, brick: 3, ore: 1, sheep: 1, wheat: 1 }); // 10 cards
    const fits = rankLiveStrategies(t, "Nick");
    const roadExpand = fits.find((f) => f.strategy.id === "road-expand")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: roadExpand,
      gs: null, // no board: road/settlement can't be placed, dev still can
      advice: null,
      rolledThisTurn: true,
    });
    expect(d?.kind).toBe("end-turn");
    expect(d?.describe).toContain("save for");
  });

  it("bank-trades a lopsided over-limit hand toward the next build", () => {
    // road-expand wants wood+brick; a pile of sheep can't build anything and
    // there's no dev/city to dump into -> it should trade sheep away, not idle.
    const t = trackerWith({ sheep: 10 }, false); // 10 sheep only, nothing buildable
    const fits = rankLiveStrategies(t, "Nick");
    const roadExpand = fits.find((f) => f.strategy.id === "road-expand")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: roadExpand,
      gs: null,
      advice: null,
      rolledThisTurn: true,
    });
    expect(d?.kind).toBe("bank-trade");
    expect(d?.trade?.give).toBe("sheep");
    // road-expand's first build (road) needs wood or brick
    expect(d?.evaluation?.alternatives[0].kind).toBe("dev");
    expect(["wheat", "ore"]).toContain(d?.trade?.get);
    expect(d?.trade?.giveCount).toBe(4); // default 4:1 with no port
  });

  it("trades toward a build proactively, under the limit (4 wood -> wheat for a city)", () => {
    // 3 ore + 1 wheat + 4 wood = 8 cards (under the 9 limit). A city needs
    // 3 ore + 2 wheat: one 4:1 wood->wheat trade completes it, so it should
    // trade now rather than sit on the wood.
    const t = trackerWith({ ore: 3, wheat: 1, wood: 4 }, false);
    const fits = rankLiveStrategies(t, "Nick");
    const cityDev = fits.find((f) => f.strategy.id === "city-dev")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: cityDev,
      gs: null,
      advice: null,
      rolledThisTurn: true,
    });
    expect(d?.kind).toBe("bank-trade");
    expect(d?.trade).toEqual({ give: "wood", get: "wheat", giveCount: 4 });
    expect(d?.describe).toContain("fund city");
  });

  it("does not trade toward a build it cannot complete even with trades", () => {
    // 3 wood only: a city (3 ore + 2 wheat) needs 5 cards; 3 wood mints 0 at
    // 4:1, so it's unreachable -> no trade, just end the turn.
    const t = trackerWith({ wood: 3 }, false);
    const fits = rankLiveStrategies(t, "Nick");
    const cityDev = fits.find((f) => f.strategy.id === "city-dev")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: cityDev,
      gs: null,
      advice: null,
      rolledThisTurn: true,
    });
    expect(d?.kind).toBe("end-turn");
  });

  it("planBankTrade returns null when nothing tradeable helps", () => {
    // exactly one sheep: no surplus at any ratio -> no trade
    const t = trackerWith({ sheep: 1 }, false);
    const fits = rankLiveStrategies(t, "Nick");
    const you = t.players.get("Nick")!;
    expect(planBankTrade(you.hand, you.bankRatio, fits[0])).toBeNull();
  });

  it("still ends the turn normally when under the limit", () => {
    const t = trackerWith({ ore: 1, sheep: 1, wheat: 1 }); // 3 cards, dev affordable
    const fits = rankLiveStrategies(t, "Nick");
    const roadExpand = fits.find((f) => f.strategy.id === "road-expand")!;
    const d = decideNext({
      tracker: t,
      youName: "Nick",
      fit: roadExpand,
      gs: null,
      advice: null,
      rolledThisTurn: true,
    });
    expect(d?.kind).toBe("end-turn"); // no pressure — follow the strategy
  });
});

describe("strategy upgrades (dice shoe, monopoly defense, robber blocking)", () => {




  it("blocks the number likeliest to roll next (balanced-dice due-ness)", () => {
    const t = createTracker("Nick");
    for (let i = 0; i < 5; i++) applyEvent(t, { type: "roll", player: "Nick", total: 6 });
    // sixes are exhausted in the shoe; nines still have all 4 combos
    const deck = deckStatus(t);
    const probOf = (n: number) => deck.prob.get(n) ?? pips(n) / 36;

    const h6 = board.hexes.find((h) => h.token === 6)!;
    const h9 = board.hexes.find((h) => h.token === 9)!;
    // vertices must NOT touch the other hex, or both tiles would block both
    const v6 = board.vertices.find((v) => v.hexIds.includes(h6.id) && !v.hexIds.includes(h9.id))!;
    const v9 = board.vertices.find((v) => v.hexIds.includes(h9.id) && !v.hexIds.includes(h6.id))!;
    const gs = {
      state: {
        board,
        buildings: [
          { vertexId: v6.id, player: 1, kind: "settlement" as const },
          { vertexId: v9.id, player: 1, kind: "settlement" as const },
        ],
        roads: [],
      },
      youPlayer: 0 as const,
    } as { state: GameState; youPlayer: 0 };
    const r = bestRobberHex(gs.state, 0, null, () => true, probOf)!;
    // The robber must land on a tile PAYING her due-9 corner (any hex touching
    // v9 scores identically) — never on one paying only the cold 6.
    const chosen = board.hexes.find((h) => h.q === r.hex.x && h.r === r.hex.y)!;
    expect(board.vertices[v9.id].hexIds).toContain(chosen.id);
    expect(board.vertices[v6.id].hexIds).not.toContain(chosen.id);
  });

  it("friendly robber parks on the spot the opponent is expanding into", () => {
    // Ava settlement + one road; nobody robbable (<3 VP). The tile touching
    // her road's far end should beat an arbitrary empty tile.
    const vA = board.vertices.find((x) => x.hexIds.length === 3 && x.adjacent.length === 3)!;
    const vB = vA.adjacent[0];
    const eAB = board.edges.find(
      (e) => (e.a === vA.id && e.b === vB) || (e.a === vB && e.b === vA.id),
    )!;
    const gs = {
      state: {
        board,
        buildings: [
          { vertexId: vA.id, player: 1, kind: "settlement" as const },
        ],
        roads: [{ edgeId: eAB.id, player: 1 }],
      },
      youPlayer: 0 as const,
    } as { state: GameState; youPlayer: 0 };
    const target = bestRobberHex(gs.state, 0, null, () => false)!;
    expect(target.victim).toBeNull();
    expect(target.describe).toContain("expanding into");
    // the chosen tile touches SOME buildable corner within 2 edges of Ava's
    // network — that's what "expanding into" means
    const chosenHexId = board.hexes.find(
      (h) => h.q === target.hex.x && h.r === target.hex.y,
    )!.id;
    const reachableCorners = board.vertices.filter(
      (v) =>
        isVertexBuildable(gs.state, v.id) &&
        v.hexIds.includes(chosenHexId) &&
        distanceFromPlayer(gs.state, 1, v.id) <= 2,
    );
    expect(reachableCorners.length).toBeGreaterThan(0);
  });

  it("snaps to a fresh-shoe view when colonist's early reshuffle likely fired", () => {
    const t = createTracker("Nick");
    // consume every combo in the shoe except one 8-card: 35 of 36 gone
    t.rollsThisDeck = [];
    for (let n = 2; n <= 12; n++) {
      const count = pips(n) - (n === 8 ? 1 : 0);
      for (let k = 0; k < count; k++) t.rollsThisDeck.push(n);
    }
    const deck = deckStatus(t);
    expect(deck.totalRemaining).toBe(36); // refilled view — nothing is cold
    expect(deck.remaining.get(8)).toBe(5); // all five 8-cards are back
    expect(deck.cold).toEqual([]);
    // and probabilities sit back at base rates
    expect(deck.prob.get(8)).toBeCloseTo(5 / 36);
  });
});
