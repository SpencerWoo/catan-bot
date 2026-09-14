import { describe, expect, it } from "vitest";
import { createTracker, applyEvent } from "./tracker";
import { rankLiveStrategies } from "./copilot";
import { decideNext } from "./autopilot";
import { HandLedger } from "./handLedger";

const hand = (wood = 0, ore = 0) => ({ wood, brick: 0, sheep: 0, wheat: 0, ore });
describe("1v1 conservation ledger", () => {
  function opening() {
    const ledger = new HandLedger("Us", "Them", true);
    ledger.record(1, { type: "starting-resources", player: "Us", resources: { wood: 2 } });
    ledger.record(2, { type: "starting-resources", player: "Them", resources: { ore: 3 } });
    return ledger;
  }
  for (const known of [false, true]) for (const weSteal of [false, true]) {
    it(`resolves ${known ? "known" : "missing-icon"} ${weSteal ? "our" : "their"} steal in either delivery order`, () => {
      const ledger = opening();
      const resource: "ore" | "wood" = weSteal ? "ore" : "wood";
      const transfer = { thief: weSteal ? "Us" : "Them", victim: weSteal ? "Them" : "Us" };
      const event = known ? { type: "steal-known" as const, ...transfer, resource } : { type: "steal-unknown" as const, ...transfer };
      const after = { mine: weSteal ? hand(2, 1) : hand(1), opponentTotal: weSteal ? 2 : 4 };
      expect(ledger.project(after).health).toBe("repairing"); // snapshot arrives first
      ledger.record(3, event);
      expect(ledger.project(after)).toMatchObject({ health: "exact", opponent: weSteal ? hand(0, 2) : hand(1, 3) });
      ledger.record(3, event); // DOM row repeated
      expect(ledger.project(after).health).toBe("exact");
      expect(ledger.project({ mine: hand(2), opponentTotal: 3 }).health).toBe("repairing"); // stale snapshot
    });
  }
  it("accounts for intervening gains and trades and replays late rows", () => {
    const ledger = opening();
    ledger.record(5, { type: "steal-unknown", thief: "Them", victim: "Us" });
    ledger.record(4, { type: "bank-trade", player: "Us", delta: { wood: -4, ore: 1 }, gave: 4, took: 1 });
    ledger.record(3, { type: "got", player: "Us", resources: { wood: 2 } });
    expect(ledger.project({ mine: hand(), opponentTotal: 4 })).toMatchObject({ health: "exact", opponent: hand(0, 4) });
    const restored = new HandLedger("Us", "Them", true);
    for (const { id, event } of ledger.export()) restored.record(id, event);
    expect(restored.project({ mine: hand(), opponentTotal: 4 }).health).toBe("exact");
  });
  it("does not call missing history exact or repair a contradiction by trimming", () => {
    expect(new HandLedger("Us", "Them").project({ mine: hand(), opponentTotal: 10 }).health).toBe("incomplete");
    expect(opening().project({ mine: hand(), opponentTotal: 10 }).opponent).toBeNull();
  });
});

describe("Monopoly evidence", () => {
  it("never selects empty ore when the opponent holds ten wood", () => {
    const tracker = createTracker("Us");
    applyEvent(tracker, { type: "place", player: "Us", color: "red", what: "settlement" });
    applyEvent(tracker, { type: "roll", player: "Them", total: 8 });
    applyEvent(tracker, { type: "got", player: "Them", resources: { ore: 2 } });
    const them = tracker.players.get("Them")!;
    them.hand = { wood: 10, brick: 0, sheep: 0, wheat: 0, ore: 0 };
    them.serverCards = 10;
    const decision = decideNext({ tracker, youName: "Us", fit: rankLiveStrategies(tracker, "Us")[0],
      gs: null, advice: null, rolledThisTurn: true, hasMonopoly: true });
    expect(decision?.kind === "play-monopoly" && decision.resource === "ore").toBe(false);
  });
});
