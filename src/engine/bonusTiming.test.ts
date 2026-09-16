import { expect, it } from "vitest";
import { bonusTiming } from "./bonusTiming";
import { analyzeVictory, BUILD, PlayerVictoryInput, VictoryPlan, VictoryStep } from "./winnability";

const empty = () => ({ wood: 0, brick: 0, sheep: 0, wheat: 0, ore: 0 });
const player = (): PlayerVictoryInput => ({ name: "us", isYou: true, publicVp: 2,
  settlementsLeft: 3, citiesLeft: 4, roadsLeft: 10, settlementsOnBoard: 2,
  settlementSpotOpen: true, knightsPlayed: 2, knightsInHand: 1, playableKnights: 1,
  longestRoadLen: 4, longestRoadPath: [1], hand: { ...empty(), wood: 1, brick: 1 },
  production: { ...empty(), ore: 0.5, wheat: 0.5 }, rollsPerTurn: 1 });
const step = (kind: "largest-army" | "longest-road"): VictoryStep => ({ kind, vp: 2, cost: {}, note: kind });
function plan(p: PlayerVictoryInput, steps: VictoryStep[]): VictoryPlan {
  return { ...analyzeVictory([p], { target: 10, devDeckLeft: 25 })[0], steps,
    planVp: steps.reduce((n, s) => n + s.vp, 0) };
}
const city: VictoryStep = { kind: "city", cost: BUILD.city, vp: 1, note: "city" };

it.each(["largest-army", "longest-road"] as const)("defers early %s despite an affordable bonus in the victory plan", kind => {
  const p = player();
  expect(bonusTiming([p], [plan(p, [city, city, city, step(kind)])], 10, kind)).toBeNull();
});

it("starts knight preparation at the play deadline, not when the army first appears", () => {
  const p = { ...player(), publicVp: 7, knightsPlayed: 0, knightsInHand: 3,
    hand: { ...empty(), ore: 3 }, production: { ...empty(), wheat: 0.5 } };
  const plans = [plan(p, [city, step("largest-army")])];
  expect(bonusTiming([p], plans, 10, "largest-army", true)).toBeNull(); // city in 4 turns
  p.hand.wheat = 0.5; // waiting one more turn still meets the three-turn deadline
  expect(bonusTiming([p], plans, 10, "largest-army", true)).toBeNull();
  p.hand.wheat = 1; // city in 2 turns; three knights need this turn plus two more
  expect(bonusTiming([p], plans, 10, "largest-army", true)).toContain("deadline");
});

it.each(["largest-army", "longest-road"] as const)("allows %s for the actual victory threshold, including hidden VP", kind => {
  const p = { ...player(), publicVp: 12, hiddenVp: 1 };
  expect(bonusTiming([p], [plan(p, [step(kind)])], 15, kind)).toContain("victory threshold");
  p.hiddenVp = 0;
  expect(bonusTiming([p], [plan(p, [city, step(kind)])], 15, kind)).toBeNull();
});

it.each(["largest-army", "longest-road"] as const)("takes %s away from an imminent winner without chasing a distant holder", kind => {
  const army = kind === "largest-army";
  const p = { ...player(), knightsPlayed: 3, longestRoadLen: 5 };
  const opponent = { ...player(), name: "them", isYou: false, publicVp: 9,
    knightsPlayed: 3, longestRoadLen: 5, holdsLargestArmy: army, holdsLongestRoad: !army };
  const theirs = { ...plan(opponent, [city]), turnsToWin: 1 };
  const plans = [plan(p, [city, city, city]), theirs];
  expect(bonusTiming([p, opponent], plans, 10, kind)).toContain("deny");
  const unfunded = army ? { ...p, knightsPlayed: 2 } : { ...p, hand: empty() };
  expect(bonusTiming([unfunded, opponent], plans, 10, kind)).toBeNull();
  theirs.turnsToWin = 5;
  expect(bonusTiming([p, opponent], plans, 10, kind)).toBeNull();
  theirs.turnsToWin = 1; theirs.planVp = 3;
  expect(bonusTiming([p, opponent], plans, 10, kind)).toBeNull(); // removing 2 cannot stop this finish
});

it("does not treat unavailable road routes as preparation", () => {
  const p = { ...player(), publicVp: 8, longestRoadPath: null };
  expect(bonusTiming([p], [plan(p, [step("longest-road")])], 10, "longest-road")).toBeNull();
});

it('defends held Largest Army against a tied late-game contender, but does not spend on a safe lead', () => {
  const me = { ...player(), publicVp: 7, knightsPlayed: 3, holdsLargestArmy: true };
  const them = { ...player(), name: 'them', isYou: false, publicVp: 7, knightsPlayed: 3, developmentCards: 1 };
  expect(bonusTiming([me, them], [], 10, 'largest-army', true)).toContain('defend');
  expect(bonusTiming([me, { ...them, knightsPlayed: 2 }], [], 10, 'largest-army', true)).toBeNull();
  expect(bonusTiming([{ ...me, playableKnights: 0 }, them], [], 10, 'largest-army', true)).toBeNull();
  expect(bonusTiming([me, { ...them, developmentCards: 0 }], [], 10, 'largest-army', true)).toBeNull();
});
