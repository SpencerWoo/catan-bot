import { expect, it } from 'vitest';
import uzi from './__fixtures__/latest-games/uzi-won.json';
import simpy from './__fixtures__/latest-games/simpy-lost.json';
import { createTracker, applyEvent } from './tracker';
import { planPosition, settlementRoutes, vertexIncome, roadBonusPath } from './planning';
import { rankLiveStrategies } from './copilot';
import { decideNext } from './autopilot';
import { GameState, PlayerId } from '../engine/types';
import { PlayerVictoryInput } from '../engine/winnability';

// Observational replay: preserve recorded hand health. These incomplete captures
// reproduce the bot's inputs; they do not establish counterfactual game outcomes.
for (const [log, indices] of [[uzi, [32]], [simpy, [75, 77, 79]]] as const) {
  for (const source of indices) it(`uses a productive affordable action in ${log.winner} decision ${source}`, () => {
    const d = log.decisions.find(d => d.sourceDecision === source)!;
    const state = { board: log.boardGeometry, ...d.position } as GameState;
    const inputs = structuredClone(d.planningInputs) as PlayerVictoryInput[];
    const me = inputs.find(p => p.isYou)!;
    const tracker = createTracker(log.you);
    for (const p of inputs) {
      applyEvent(tracker, { type: 'place', player: p.name, color: p.name, what: 'settlement' });
      const held = d.hands.find(h => h.name === p.name)!;
      Object.assign(tracker.players.get(p.name)!, { hand: { ...held.hand }, serverCards: held.total,
        serverVp: held.publicVp, trackingHealth: held.health, bankRatio: p.bankRatios });
      p.settlementRoutes = settlementRoutes(state, p.playerId as PlayerId);
      p.cityProduction = state.buildings.filter(b => b.player === p.playerId && b.kind === 'settlement')
        .map(b => vertexIncome(state, b.vertexId, 1));
      p.longestRoadPath = p.holdsLongestRoad ? [] : roadBonusPath(state, p.playerId as PlayerId,
        Math.max(5, 1 + Math.max(...inputs.map(p => p.longestRoadLen))), p.roadsLeft ?? 0);
    }
    const gs = { state, youPlayer: me.playerId as PlayerId };
    const planning = planPosition(tracker, log.you, gs, { inputs, target: log.settings.victoryPointsToWin,
      devDeckLeft: d.bankDevCards });
    const decision = decideNext({ tracker, youName: log.you, gs, planning, fit: rankLiveStrategies(tracker, log.you)[0], advice: null,
      rolledThisTurn: true, bankDevCards: d.bankDevCards, discardLimit: log.settings.discardLimit });
    if (source === 32) expect(decision?.kind).toBe('build-city');
    else {
      expect(decision?.kind).toBe('bank-trade');
      expect(decision?.funding).toEqual({ kind: 'city', vertexId: 3 });
      expect(decision?.trade?.giveCount).toBe(4);
    }
  });
}

it('does not chase a phantom Longest Road award in the retained win', () => {
  const d = uzi.decisions.find(d => d.sourceDecision === 90)!;
  const me = d.planningInputs.find(p => p.isYou)!;
  // At 12 versus 7, the unique leader already owns the award. The old wire
  // mapping instead treated the absence of a held VP card as "no Longest Road".
  expect(me.longestRoadLen).toBe(12);
  expect(me.holdsLongestRoad).toBe(false);
  const tracker = createTracker(uzi.you);
  for (const p of d.planningInputs) {
    applyEvent(tracker, { type: 'place', player: p.name, color: p.name, what: 'settlement' });
    Object.assign(tracker.players.get(p.name)!, { hand: { ...p.hand }, bankRatio: p.bankRatios });
  }
  const state = { board: uzi.boardGeometry, ...d.position } as GameState;
  const inputs = structuredClone(d.planningInputs) as PlayerVictoryInput[];
  inputs.find(p => p.isYou)!.holdsLongestRoad = true;
  for (const p of inputs) p.settlementRoutes = settlementRoutes(state, p.playerId as PlayerId);
  const planning = planPosition(tracker, uzi.you, { state, youPlayer: me.playerId as PlayerId },
    { inputs, target: uzi.settings.victoryPointsToWin, devDeckLeft: d.bankDevCards });
  expect(planning.builds.some(b => b.kind === 'road')).toBe(false);
  expect(planning.builds.filter(b => b.kind === 'settlement').every(b => (b.roadEdges?.length ?? 0) <= me.roadsLeft)).toBe(true);
});
