import { expect, it } from "vitest";
import logs from "./__fixtures__/latest-games/discard-holds.json";
import { GameLog } from "./gameLog";
import { replayDecision } from "./replay";
import fornero from "./__fixtures__/latest-games/fornero-discard.json";
import { decideNext } from "./autopilot";
import { rankLiveStrategies } from "./copilot";
import { planPosition } from "./planning";

for (const [index, captured] of fornero.decisions.entries()) {
  it(`funds a useful purchase rather than the Fornero hold at decision ${captured.sourceDecision}`, () => {
    const replay = replayDecision(fornero as unknown as GameLog, index);
    expect(replay.decision).toMatchObject({ kind: "bank-trade", trade: { get: "wheat" }, funding: { kind: "dev" } });
    const spending = replay.decision!.evaluation!.spending!;
    const dev = spending.alternatives.find(a => a.kind === "dev")!;
    expect(dev.expectedLoss).toBeLessThan(spending.savedLoss);
    expect(dev.continuationValue).toBeGreaterThan(0);
    expect(dev.constructionDelay).toBeGreaterThan(0);
    expect(dev.score).toBeGreaterThan(spending.savingScore);

    // Follow the actual whole-card trade with its funded purchase. No card
    // acquired for this plan may be immediately exchanged back.
    const { tracker, gs, planning } = replay;
    const you = tracker!.players.get(fornero.you)!;
    const trade = replay.decision!.trade!;
    you.hand[trade.give] -= trade.giveCount;
    you.hand[trade.get]++;
    const remainingCards = Object.values(you.hand).reduce((a, b) => a + b, 0);
    you.serverCards = remainingCards;
    const updated = planPosition(tracker!, fornero.you, gs!, {
      target: 15, devDeckLeft: captured.bankDevCards, robberHex: captured.robberHex,
      inputs: planning!.inputs.map(p => p.isYou ? { ...p, hand: { ...you.hand }, resourceCardCount: remainingCards } : p),
    });
    const next = decideNext({ tracker: tracker!, gs: gs!, planning: updated,
      youName: fornero.you, advice: null, fit: rankLiveStrategies(tracker!, fornero.you)[0],
      rolledThisTurn: true, bankDevCards: captured.bankDevCards, funding: replay.decision!.funding });
    expect(next?.kind).toBe("buy-dev");
    expect(you.serverCards - 3).toBe(dev.remainingCards);
  });
}

for (const log of logs) for (const [index, captured] of log.decisions.entries()) {
  it(`replays the pre-discard hold in ${log.at} decision ${captured.sourceDecision}`, () => {
    const replay = replayDecision(log as unknown as GameLog, index);
    expect(replay.decision).not.toBeNull();
    // Two alternatives require costly conversions or lack a legal purchase;
    // a historical discard is not by itself proof that saving was wrong.
    const expected = new Map([[60, "end-turn"], [51, "end-turn"], [100, "buy-dev"],
      [18, "build-road"], [52, "bank-trade"], [79, "bank-trade"]]);
    expect(replay.decision?.kind).toBe(expected.get(captured.sourceDecision));
    if (captured.sourceDecision === 100) {
      const spending = replay.decision!.evaluation!.spending!;
      const dev = spending.alternatives.find(a => a.kind === "dev")!;
      expect(spending.savedLoss).toBeGreaterThan(0);
      expect(dev.expectedLoss).toBe(0);
      expect(dev.constructionDelay).toBe(0);
    }
    if (captured.sourceDecision === 52) {
      expect(replay.decision).toMatchObject({ trade: { give: "sheep", giveCount: 4, get: "wheat" }, funding: { kind: "dev" } });
      const spending = replay.decision!.evaluation!.spending!;
      const dev = spending.alternatives.find(a => a.kind === "dev")!;
      expect(dev.expectedLoss).toBeLessThan(spending.savedLoss);
      expect(dev.constructionDelay).toBeGreaterThan(0);
      expect(dev.continuationValue).toBeGreaterThan(0);
    }
    if (replay.decision?.kind === "end-turn") {
      expect(replay.decision.evaluation?.spending?.selected).toBe("save");
      expect(replay.decision.describe).not.toContain("~0.0 turns");
    }
  });
}
