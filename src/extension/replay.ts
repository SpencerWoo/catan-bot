import { decideNext } from "./autopilot";
import { rankLiveStrategies } from "./copilot";
import { GameState } from "../engine/types";
import { TrackerState } from "./tracker";
import { GameLog } from "./gameLog";
import { PlayerId } from "../engine/types";
import { createTracker, applyEvent } from "./tracker";
import { planPosition, settlementRoutes, vertexIncome, roadBonusPath, PlanningContext } from "./planning";

/** Re-evaluate a captured position, without claiming a counterfactual outcome.
 * Older text-only logs explicitly fail this contract. */
export function replayPlanning(log: GameLog, index: number, observational = false): { planning: PlanningContext | null; reason?: string; tracker?: TrackerState; gs?: { state: GameState; youPlayer: PlayerId } } {
  const decision = log.decisions?.[index];
  if (!log.you || !log.boardGeometry || !decision?.position || !decision.planningInputs || log.settings.victoryPointsToWin === null) {
    return { planning: null, reason: "Missing decision-time state; text-only history cannot be exactly replayed" };
  }
  const inputs = structuredClone(decision.planningInputs);
  const me = inputs.find((p) => p.isYou);
  if (me?.playerId === undefined) return { planning: null, reason: "Missing player mapping" };
  const state = { board: log.boardGeometry, ...decision.position };
  const tracker = createTracker(log.you);
  tracker.discardLimit = log.settings.discardLimit;
  for (const entry of log.events ?? []) {
    if (entry.id > decision.eventIndex) break;
    if (entry.event.type === "roll") applyEvent(tracker, entry.event);
  }
  for (const input of inputs) {
    const held = decision.hands.find((h) => h.name === input.name);
    if (!held || (!observational && held.health !== "exact")) return { planning: null, reason: "Hand tracking was incomplete at this decision" };
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
  const gs = { state, youPlayer: me.playerId as PlayerId };
  return { tracker, gs, planning: planPosition(tracker, log.you, { state, youPlayer: me.playerId as PlayerId }, {
    target: log.settings.victoryPointsToWin, inputs, devDeckLeft: decision.bankDevCards,
    robberHex: decision.robberHex,
  }) };
}

/** Observational replay preserves uncertain opponent hands instead of inventing
 * exact state. It compares one decision, not an alternate game outcome. */
export function replayDecision(log: GameLog, index: number) {
  const replay = replayPlanning(log, index, true);
  const captured = log.decisions?.[index];
  if (!replay.planning || !replay.tracker || !replay.gs || !captured || !log.you) return { ...replay, decision: null };
  const me = captured.planningInputs!.find(p => p.isYou)!;
  return { ...replay, decision: decideNext({ tracker: replay.tracker, gs: replay.gs, planning: replay.planning,
    youName: log.you, advice: null, fit: rankLiveStrategies(replay.tracker, log.you)[0], rolledThisTurn: true,
    winTarget: log.settings.victoryPointsToWin ?? undefined, discardLimit: log.settings.discardLimit,
    bankDevCards: captured.bankDevCards, robberHex: captured.robberHex,
    vpCardsHeld: me.hiddenVp, piecesLeft: { settlements: me.settlementsLeft ?? null,
      cities: me.citiesLeft ?? null, roads: me.roadsLeft ?? null } }) };
}
