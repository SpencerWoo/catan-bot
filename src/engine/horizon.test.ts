import { describe, expect, it } from "vitest";
import { evaluateBuilds, gameHorizon, turnsToAfford, BuildOption } from "./horizon";
import { analyzeVictory, BUILD, Hand, PlayerVictoryInput } from "./winnability";

const empty = (): Hand => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
describe("remaining game horizon", () => {
  it("accounts for the bottleneck resource and usable port ratios", () => {
    const rate = { ...empty(), wood: 1 };
    expect(turnsToAfford({ wheat: 1 }, empty(), rate)).toBeCloseTo(4);
    expect(turnsToAfford({ wheat: 1 }, empty(), rate, { wood: 2 })).toBeCloseTo(2);
    expect(turnsToAfford(BUILD.city, { ...empty(), ore: 3 }, { ...empty(), wheat: 1 })).toBeCloseTo(2);
    expect(turnsToAfford(BUILD.city, empty(), empty())).toBe(Infinity);
  });
  it("saves for productive growth with time remaining and takes the affordable point in a short race", () => {
    const hand = { wood: 1, brick: 1, sheep: 1, wheat: 2, ore: 2 };
    const rate = { ...empty(), ore: 1 };
    const options: BuildOption[] = [
      { kind: "city", vp: 1, cost: BUILD.city, production: { ...empty(), wheat: 1.5, ore: 1.5 } },
      { kind: "settlement", vp: 1, cost: BUILD.settlement, production: { ...empty(), wood: 0.1 } },
      { kind: "dev", vp: 0.4, cost: BUILD.dev, production: empty() },
    ];
    const rank = (turns: number) => evaluateBuilds(options, hand, rate, {}, { wheat: 15, ore: 15 }, 4, gameHorizon([turns]));
    expect(rank(20)[0].kind).toBe("city");
    expect(rank(0.5)[0].kind).toBe("settlement");
    const a = rank(6).find((x) => x.kind === "city")!.score;
    const b = rank(6.001).find((x) => x.kind === "city")!.score;
    expect(Math.abs(b - a)).toBeLessThan(0.01);
  });
  it("changes the horizon at the same point gap when the opponent produces faster", () => {
    const player = (name: string, rate: number): PlayerVictoryInput => ({ name, isYou: name === "us",
      publicVp: 6, settlementsLeft: 0, citiesLeft: 4, roadsLeft: 0, settlementsOnBoard: 4,
      settlementSpotOpen: false, knightsPlayed: 0, longestRoadLen: 0, hand: empty(),
      production: { wood: rate, brick: rate, sheep: rate, wheat: rate, ore: rate } });
    const horizon = (rate: number) => gameHorizon(analyzeVictory([player("us", 0.1), player("them", rate)],
      { target: 10, devDeckLeft: 0 }).map((p) => p.turnsToWin));
    expect(horizon(1).turns).toBeLessThan(horizon(0.1).turns);
    expect(horizon(1).urgency).toBeGreaterThan(horizon(0.1).urgency);
  });
  it("values a port only when it can convert surplus within the remaining horizon", () => {
    const base: BuildOption = { kind: "settlement", cost: BUILD.settlement, vp: 1, production: empty() };
    const port = { ...base, ratios: { wood: 2 } };
    const hand = { wood: 1, brick: 1, sheep: 1, wheat: 1, ore: 0 };
    const rank = (wood: number) => evaluateBuilds([base, port], { ...hand, wood }, empty(), {}, {}, 3, gameHorizon([3]));
    expect(rank(1)[0].score).toBe(rank(1)[1].score);
    expect(rank(15)[0].ratios?.wood).toBe(2);
    expect(rank(15)[0].score).toBeGreaterThan(rank(15)[1].score);
  });
  it("does not infer victory or exhaustion from a missing resource source alone", () => {
    expect(gameHorizon([Infinity, 2]).turns).toBe(2);
    expect(gameHorizon([10, 0]).turns).toBe(0);
  });
});
