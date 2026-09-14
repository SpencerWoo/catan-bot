import { GameLog } from "./gameLog";
import { PlayerId } from "../engine/types";
import { createTracker, applyEvent } from "./tracker";
import { planPosition, settlementRoutes, vertexIncome, roadBonusPath, PlanningContext } from "./planning";

/** Re-evaluate a captured position, without claiming a counterfactual outcome.
 * Older text-only logs explicitly fail this contract. */
export function replayPlanning(log: GameLog, index: number): { planning: PlanningContext | null; reason?: string } {
  const decision = log.decisions?.[index];
  if (!log.you || !log.boardGeometry || !decision?.position || !decision.planningInputs || log.settings.victoryPointsToWin === null) {
    return { planning: null, reason: "Missing decision-time state; text-only history cannot be exactly replayed" };
  }
  const inputs = structuredClone(decision.planningInputs);
  const me = inputs.find((p) => p.isYou);
  if (me?.playerId === undefined) return { planning: null, reason: "Missing player mapping" };
  const state = { board: log.boardGeometry, ...decision.position };
  const tracker = createTracker(log.you);
  for (const input of inputs) {
    const held = decision.hands.find((h) => h.name === input.name);
    if (!held || held.health !== "exact") return { planning: null, reason: "Hand tracking was incomplete at this decision" };
    applyEvent(tracker, { type: "place", player: input.name, color: input.name, what: "settlement" });
    const player = tracker.players.get(input.name)!;
    player.hand = { ...held.hand }; player.serverCards = held.total; player.serverVp = held.publicVp;
    player.trackingHealth = held.health; player.bankRatio = input.bankRatios ?? {};
    if (input.playerId === undefined) return { planning: null, reason: "Missing opponent mapping" };
    input.settlementRoutes = settlementRoutes(state, input.playerId as PlayerId);
    input.cityProduction = state.buildings.filter((b) => b.player === input.playerId && b.kind === "settlement")
      .map((b) => vertexIncome(state, b.vertexId, 1));
    input.longestRoadPath = input.holdsLongestRoad ? [] : roadBonusPath(state, input.playerId as PlayerId,
      Math.max(5, 1 + Math.max(...inputs.map((p) => p.longestRoadLen))), input.roadsLeft ?? 0);
  }
  return { planning: planPosition(tracker, log.you, { state, youPlayer: me.playerId as PlayerId }, {
    target: log.settings.victoryPointsToWin, inputs, devDeckLeft: decision.bankDevCards,
    robberHex: decision.robberHex,
  }) };
}
