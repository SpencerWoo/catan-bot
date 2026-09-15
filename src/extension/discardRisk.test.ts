import { describe, expect, it } from "vitest";
import { createTracker, applyEvent } from "./tracker";
import { discardIncome, expectedDiscardLoss, sevenExposure } from "./discardRisk";
import { zeroHand, planPosition } from "./planning";
import { decideNext } from "./autopilot";
import { rankLiveStrategies } from "./copilot";
import { evaluateBuilds } from "../engine/horizon";
import { generateBoard } from "../engine/board";

function riskTracker(hot: boolean) {
  const t = createTracker("Us");
  for (const player of ["Us", "Them"]) applyEvent(t, { type: "place", player, color: player, what: "settlement" });
  t.discardLimit = 7;
  t.rollsThisDeck = hot ? [2, 3, 3, 4, 4, 4, 5, 5, 5, 5, 6, 6, 6, 6, 6,
    8, 8, 8, 8, 8, 9, 9, 9, 9, 10, 10, 10, 11, 11] : [7, 7, 7, 7, 7, 7];
  return t;
}

describe("seven exposure", () => {
  it("draws without replacement and includes the next own roll", () => {
    const t = createTracker("Us");
    expect(sevenExposure(t, 2)).toBeCloseTo(1 - 30 / 36 * 29 / 35);
    expect(sevenExposure(t, 4)).toBeGreaterThan(sevenExposure(t, 2));
  });
  it("refills a cold deck at the existing boundary", () => {
    const t = riskTracker(false);
    expect(sevenExposure(t, 2)).toBe(0);
    expect(sevenExposure(t, 26)).toBeCloseTo(1 / 6);
    expect(sevenExposure(riskTracker(true), 2)).toBe(1);
  });
  it("values surplus losses and residual oversized hands, but respects the limit", () => {
    const t = riskTracker(true);
    expect(expectedDiscardLoss(t, { ...zeroHand(), wood: 7 }, 7)).toBe(0);
    expect(expectedDiscardLoss(t, { ...zeroHand(), wood: 8 }, 7)).toBe(4);
    expect(expectedDiscardLoss(t, { ...zeroHand(), wood: 12 }, 7)).toBeCloseTo(6);
    expect(expectedDiscardLoss(t, { ...zeroHand(), wood: 10 }, 7)).toBe(5);
  });
});

function partialTrade(hot: boolean, ratio = 3, fewerRolls = false) {
  const t = riskTracker(hot), us = t.players.get("Us")!;
  if (fewerRolls) t.rollsThisDeck = t.rollsThisDeck.slice(0, 22);
  us.hand = { ...zeroHand(), wheat: 6, wood: 2 };
  us.bankRatio = { wheat: ratio };
  const board = generateBoard(42);
  const gs = { state: { board, buildings: [{ player: 0 as const, vertexId: 0, kind: "settlement" as const }], roads: [] }, youPlayer: 0 as const };
  const planning = planPosition(t, "Us", gs, { devDeckLeft: 0 });
  // Production makes the target credible within the race; no immediate purchase.
  planning.production = { ...zeroHand(), ore: 1 };
  planning.horizon.turns = 12;
  planning.builds = planning.builds.filter(b => b.kind === "city");
  return decideNext({ tracker: t, youName: "Us", fit: rankLiveStrategies(t, "Us")[0], gs, advice: null,
    rolledThisTurn: true, planning, bankDevCards: 0 });
}

it("makes a useful incomplete trade at high risk and saves the same hand at low risk", () => {
  expect(partialTrade(true)).toMatchObject({ kind: "bank-trade", trade: { give: "wheat", giveCount: 3, get: "ore" }, funding: { partial: true } });
  expect(partialTrade(true)?.describe).toContain("seven risk");
  expect(partialTrade(false)?.kind).toBe("end-turn");
});
it("rejects a conversion whose cost exceeds the avoided discard", () => {
  expect(partialTrade(true, 4, true)?.kind).toBe("end-turn");
});

it("buys a useful dev card under high exposure but preserves the city budget when sevens are cold", () => {
  const decide = (hot: boolean) => {
    const t = riskTracker(hot), us = t.players.get("Us")!;
    us.hand = { wood: 4, brick: 3, ore: 1, wheat: 1, sheep: 1 };
    const planning = planPosition(t, "Us", null);
    planning.production = { ...zeroHand(), ore: 1, wheat: 1 };
    planning.horizon.turns = 12;
    // Keep production value neutral to isolate the reserve-vs-purchase choice.
    planning.builds.forEach(b => { b.production = zeroHand(); });
    planning.builds = evaluateBuilds(planning.builds, us.hand, planning.production,
      us.bankRatio, planning.remaining, planning.gap, planning.horizon);
    return decideNext({ tracker: t, youName: "Us", fit: rankLiveStrategies(t, "Us")[0],
      gs: null, advice: null, rolledThisTurn: true, planning });
  };
  expect(decide(true)?.kind).toBe("buy-dev");
  expect(decide(false)?.kind).toBe("end-turn");
});

it("keeps a partial trade's target after confirmation and never exchanges its received ore back", () => {
  const t = riskTracker(true), us = t.players.get("Us")!;
  us.hand = { ...zeroHand(), wheat: 6, wood: 2 };
  us.bankRatio = { wheat: 3, ore: 2 };
  let funding: import("./autopilot").AutopilotDecision["funding"];
  const decide = () => {
    const planning = planPosition(t, "Us", null, { devDeckLeft: 0 });
    planning.production = { ...zeroHand(), ore: 1 };
    planning.horizon.turns = 12;
    return decideNext({ tracker: t, youName: "Us", fit: rankLiveStrategies(t, "Us")[0],
      gs: null, advice: null, rolledThisTurn: true, bankDevCards: 0, planning, funding });
  };
  const first = decide()!;
  expect(first.kind).toBe("bank-trade");
  funding = first.funding;
  us.hand[first.trade!.give] -= first.trade!.giveCount;
  us.hand[first.trade!.get]++;
  expect(decide()?.kind).toBe("end-turn");
  expect(us.hand.ore).toBe(1);
});

it("buys a dev without abandoning the valuable city when seven exposure is certain", () => {
  const t = riskTracker(true), us = t.players.get("Us")!;
  us.hand = { wood: 3, brick: 3, ore: 1, wheat: 1, sheep: 2 };
  const planning = planPosition(t, "Us", null);
  planning.production = { ...zeroHand(), ore: 1, wheat: 1 };
  planning.horizon.turns = 12;
  const city = planning.builds.find(b => b.kind === "city")!;
  city.production = { ...zeroHand(), ore: 2, wheat: 2 };
  // The pilot must independently compare reward with risk, even if the
  // incoming planning order prefers the affordable dev card.
  planning.builds.sort((a, b) => Number(b.kind === "dev") - Number(a.kind === "dev"));
  const d = decideNext({ tracker: t, youName: "Us", fit: rankLiveStrategies(t, "Us")[0],
    gs: null, advice: null, rolledThisTurn: true, planning });
  expect(d?.kind).toBe("buy-dev");
  expect(d?.evaluation?.spending?.selected).toBe("dev");
  expect(d?.evaluation?.spending?.alternatives.find(a => a.kind === "dev")?.continuationValue).toBeGreaterThan(0);
});


it("counts production before a seven even when the initial hand is at the limit", () => {
  const t = createTracker("Us");
  const hand = { ...zeroHand(), wood: 7 };
  // Only a 6 followed by a 7 causes a discard within two rolls.
  expect(expectedDiscardLoss(t, hand, 7, 2, new Map([[6, 1]]))).toBeCloseTo(5 / 36 * 6 / 35 * 4);
  expect(expectedDiscardLoss(t, hand, 7, 1, new Map([[6, 1]]))).toBe(0);
  expect(expectedDiscardLoss(t, hand, 9, 2, new Map([[6, 1]]))).toBe(0);
});

it("includes a second discard when the first still leaves too many cards", () => {
  const t = createTracker("Us");
  const hand = { ...zeroHand(), wood: 24 };
  const firstLoss = sevenExposure(t, 2) * 12;
  expect(expectedDiscardLoss(t, hand, 7, 2)).toBeCloseTo(firstLoss + 6 / 36 * 5 / 35 * 6);
});

it("uses current buildings for income and excludes the blocked hex", () => {
  const t = createTracker("Us"), board = generateBoard(42);
  const gs = { state: { board, buildings: [{ player: 0 as const, vertexId: 0, kind: "city" as const }], roads: [] }, youPlayer: 0 as const };
  const hex = board.vertices[0].hexIds.map(id => board.hexes[id]).find(h => h.kind !== "desert")!;
  const full = discardIncome(t, gs);
  const blocked = discardIncome(t, gs, { x: hex.q, y: hex.r });
  expect(full.get(hex.token!)! - (blocked.get(hex.token!) ?? 0)).toBe(2);
});

it("buys multiple development cards even when each purchase leaves residual risk", () => {
  const t = riskTracker(true), us = t.players.get("Us")!;
  us.hand = { wood: 8, brick: 0, ore: 3, wheat: 3, sheep: 3 };
  const decide = (bankDevCards = 25) => {
    const planning = planPosition(t, "Us", null);
    planning.builds = planning.builds.filter(b => b.kind === "dev");
    planning.horizon.turns = 12;
    return decideNext({ tracker: t, youName: "Us", fit: rankLiveStrategies(t, "Us")[0],
      gs: null, advice: null, rolledThisTurn: true, planning, bankDevCards });
  };
  for (let i = 0; i < 3; i++) {
    const d = decide(3 - i);
    expect(d?.kind).toBe("buy-dev");
    const spending = d!.evaluation!.spending!;
    expect(spending.alternatives.find(a => a.kind === "dev")!.expectedLoss).toBeLessThan(spending.savedLoss);
    us.hand.ore--; us.hand.wheat--; us.hand.sheep--;
    expect(Object.values(us.hand).reduce((a, b) => a + b)).toBeGreaterThan(7);
  }
  expect(decide(0)?.kind).toBe("end-turn");
});

it("still saves when spending delays a much more valuable productive build", () => {
  const t = riskTracker(true), us = t.players.get("Us")!;
  us.hand = { wood: 3, brick: 3, ore: 1, wheat: 1, sheep: 2 };
  const planning = planPosition(t, "Us", null);
  planning.production = { ...zeroHand(), ore: 1, wheat: 1 };
  planning.horizon.turns = 12;
  planning.builds.find(b => b.kind === "city")!.production = { ...zeroHand(), ore: 20, wheat: 20 };
  const d = decideNext({ tracker: t, youName: "Us", fit: rankLiveStrategies(t, "Us")[0],
    gs: null, advice: null, rolledThisTurn: true, planning });
  expect(d?.kind).toBe("end-turn");
  expect(d?.evaluation?.spending?.selected).toBe("save");
});

it("credits a dev purchase that leaves ten cards while retaining a later city", () => {
  const t = riskTracker(true), us = t.players.get("Us")!;
  us.hand = { wood: 5, brick: 5, ore: 1, wheat: 1, sheep: 1 };
  const planning = planPosition(t, "Us", null);
  planning.production = { ...zeroHand(), ore: 1, wheat: 1 };
  planning.horizon.turns = 12;
  planning.builds.forEach(b => { b.production = zeroHand(); });
  const d = decideNext({ tracker: t, youName: "Us", fit: rankLiveStrategies(t, "Us")[0],
    gs: null, advice: null, rolledThisTurn: true, planning });
  expect(d?.kind).toBe("buy-dev");
  const dev = d!.evaluation!.spending!.alternatives.find(a => a.kind === "dev")!;
  expect(dev.remainingCards).toBe(10);
  expect(dev.expectedLoss).toBeGreaterThan(0);
  expect(dev.expectedLoss).toBeLessThan(d!.evaluation!.spending!.savedLoss);
  expect(dev.continuationValue).toBeGreaterThan(0);
});
