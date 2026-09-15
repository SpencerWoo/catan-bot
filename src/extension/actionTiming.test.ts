import { expect, it, vi } from "vitest";
import { Autopilot } from "./autopilot";
import { ProtocolLearner } from "./protocolLearner";
import { applyEvent, createTracker } from "./tracker";
import { rankLiveStrategies } from "./copilot";
import { planPosition, zeroHand } from "./planning";

function setup(kind: "discard" | "bank-trade", random = vi.fn(() => 0.5), fallback = false) {
  const tracker = createTracker("Us");
  for (const player of ["Us", "Them"]) applyEvent(tracker, { type: "place", player, color: player, what: "settlement" });
  const us = tracker.players.get("Us")!;
  us.hand = kind === "discard" ? { ...zeroHand(), sheep: 8, ore: 2, wheat: 2 }
    : { ...zeroHand(), wheat: 2, ore: 2, wood: 4 };
  const planning = planPosition(tracker, "Us", null, { devDeckLeft: 0 });
  const dispatch = vi.fn(() => !fallback), domDiscard = vi.fn(() => "discard dialog");
  const learner = new ProtocolLearner();
  const schedule = vi.fn();
  const ap = new Autopilot(learner, dispatch, () => null, domDiscard, random, schedule);
  ap.setEnabled(true);
  if (kind === "discard") {
    ap.onTurnState(2, 1);
    ap.setDiscardPending(true);
  } else {
    ap.onTurnState(1, 1);
    ap.onYouRolled();
  }
  const tick = (now: number) => ap.tick({ tracker, planning, gs: null, advice: null,
    fit: rankLiveStrategies(tracker, "Us")[0], bankDevCards: 0, now });
  return { ap, tick, tracker, dispatch, domDiscard, random, learner, schedule };
}

it.each(["bank-trade", "discard"] as const)("pauses %s once, then starts the confirmation timeout at dispatch", kind => {
  const { tick, dispatch, random, learner, schedule } = setup(kind);
  const discardTemplate = vi.spyOn(learner, "discard");
  tick(0); tick(250); tick(999);
  expect(dispatch).not.toHaveBeenCalled();
  expect(random).toHaveBeenCalledOnce();
  expect(schedule).toHaveBeenCalledOnce();
  expect(schedule).toHaveBeenCalledWith(1000);
  tick(1000);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(dispatch.mock.calls[0]).toBeDefined();
  tick(8500); // More than 8s from scheduling, less than 8s from dispatch.
  expect(discardTemplate).not.toHaveBeenCalled();
  expect(dispatch).toHaveBeenCalledOnce();
  tick(9001);
  expect(discardTemplate).toHaveBeenCalledWith(kind);
});

it.each([0, 0.999999])("respects the 0–2 second bounds for random=%s", value => {
  const { tick, dispatch } = setup("discard", vi.fn(() => value));
  tick(0);
  expect(dispatch).toHaveBeenCalledTimes(value === 0 ? 1 : 0);
  tick(2000);
  expect(dispatch).toHaveBeenCalledOnce();
});

it("uses the same deadline for the discard dialog fallback", () => {
  const { tick, domDiscard, dispatch } = setup("discard", vi.fn(() => 0.5), true);
  tick(0); tick(999);
  expect(domDiscard).not.toHaveBeenCalled();
  tick(1000); tick(1100);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(domDiscard).toHaveBeenCalledOnce();
});

it("cancels when disabled or the discard phase ends, and starts fresh when reenabled", () => {
  const { ap, tick, dispatch, random } = setup("discard");
  tick(0);
  ap.setEnabled(false); tick(2000);
  expect(dispatch).not.toHaveBeenCalled();
  ap.setEnabled(true); tick(3000);
  expect(random).toHaveBeenCalledTimes(2);
  ap.setDiscardPending(false); tick(4000);
  expect(dispatch).not.toHaveBeenCalled();
  ap.setDiscardPending(true); tick(5000); tick(6000);
  expect(dispatch).toHaveBeenCalledOnce();
});

it("recomputes a changed discard hand and starts a fresh deadline", () => {
  const { tick, dispatch, tracker, random } = setup("discard");
  tick(0);
  tracker.players.get("Us")!.hand.sheep += 2;
  tick(900); tick(1000);
  expect(dispatch).not.toHaveBeenCalled();
  expect(random).toHaveBeenCalledTimes(2);
  tick(1900);
  expect(dispatch).toHaveBeenCalledOnce();
});

it("cancels a bank trade when the turn ends", () => {
  const { tick, dispatch, ap } = setup("bank-trade");
  tick(0); ap.onTurnState(2, 1); tick(1000);
  expect(dispatch).not.toHaveBeenCalled();
});

it("samples a fresh delay after a confirmed bank trade", () => {
  const { tick, dispatch, ap, random } = setup("bank-trade");
  tick(0); tick(1000); ap.onConfirm("bank-trade");
  tick(1100); tick(2099);
  expect(dispatch).toHaveBeenCalledOnce();
  tick(2100);
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(random).toHaveBeenCalledTimes(2);
});

it("does not restart a delay when an unrelated offer confirmation repeats", () => {
  const { ap, tick, dispatch, random } = setup("bank-trade");
  tick(0);
  ap.onConfirm("propose-trade");
  tick(1000);
  expect(dispatch).toHaveBeenCalledOnce();
  expect(random).toHaveBeenCalledOnce();
});
