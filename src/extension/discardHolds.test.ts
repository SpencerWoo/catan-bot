import { expect, it } from "vitest";
import logs from "./__fixtures__/latest-games/discard-holds.json";
import { GameLog } from "./gameLog";
import { replayDecision } from "./replay";

for (const log of logs) for (const [index, captured] of log.decisions.entries()) {
  it(`replays the pre-discard hold in ${log.at} decision ${captured.sourceDecision}`, () => {
    const replay = replayDecision(log as unknown as GameLog, index);
    expect(replay.decision).not.toBeNull();
    // Three alternatives require costly conversions or lack a legal purchase;
    // a historical discard is not by itself proof that saving was wrong.
    const expected = new Map([[60, "end-turn"], [51, "end-turn"], [100, "buy-dev"],
      [18, "build-road"], [52, "end-turn"], [79, "bank-trade"]]);
    expect(replay.decision?.kind).toBe(expected.get(captured.sourceDecision));
    if (captured.sourceDecision === 100) {
      const spending = replay.decision!.evaluation!.spending!;
      const dev = spending.alternatives.find(a => a.kind === "dev")!;
      expect(spending.savedLoss).toBeGreaterThan(0);
      expect(dev.expectedLoss).toBe(0);
      expect(dev.constructionDelay).toBe(0);
    }
    if (replay.decision?.kind === "end-turn") {
      expect(replay.decision.evaluation?.spending?.selected).toBe("save");
      expect(replay.decision.describe).not.toContain("~0.0 turns");
    }
  });
}
