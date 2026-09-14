import { expect, it } from "vitest";
import { turnsToAfford } from "./horizon";

it("does not pool fractional bank trades into an instant missing resource", () => {
  // UziYamal game decision 24: ten cards, zero sheep, no four-card surplus.
  const hand = { wood: 3, brick: 2, sheep: 0, wheat: 3, ore: 2 };
  const rate = { wood: 2/9, brick: 2/9, sheep: 5/18, wheat: 1/6, ore: 1/6 };
  expect(turnsToAfford({ wood: 1, brick: 1, sheep: 1, wheat: 1 }, hand, rate)).toBeGreaterThan(1);
});
