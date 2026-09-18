import { expect, it } from 'vitest';
import captured from './__fixtures__/latest-games/skullatan.json';
import { GameLog } from './gameLog';
import { replayPlanning } from './replay';
import { decideNext } from './autopilot';
import { pixelsToColonistEdge } from './coords';
import { rankLiveStrategies } from './copilot';
import { planPosition, longestRoad, roadBonusPath, settlementRoutes } from './planning';

function position(source: number, withoutRoadBonus = false) {
  const index = captured.decisions.findIndex(d => d.sourceDecision === source);
  const { planning, gs, tracker } = replayPlanning(captured as unknown as GameLog, index, true);
  // Isolate reserve/YOP decisions after the road award is unavailable.
  if (withoutRoadBonus) planning!.builds = planning!.builds.filter(b => b.kind !== 'road');
  const decide = (extra: Partial<Parameters<typeof decideNext>[0]> = {}) => decideNext({
    planning: planning!, gs: gs!, tracker: tracker!, youName: captured.you,
    advice: null, fit: rankLiveStrategies(tracker!, captured.you)[0], rolledThisTurn: true,
    bankDevCards: captured.decisions[index].bankDevCards, ...extra,
  });
  return { planning: planning!, gs: gs!, tracker: tracker!, decide };
}
it('retains Year of Plenty when the planned city cannot be completed this turn', () => {
  const p = position(92, true);
  // No wheat, no ore: taking wood + ore was followed by end-turn.
  expect(p.decide({ hasYearOfPlenty: true })?.kind).not.toBe('play-year-of-plenty');
});
it('takes two ore and commits to the city when Year of Plenty completes it', () => {
  const p = position(92, true), me = p.tracker.players.get(captured.you)!;
  me.hand = { wood: 2, brick: 1, sheep: 2, wheat: 2, ore: 1 };
  const planning = planPosition(p.tracker, captured.you, p.gs, { inputs: p.planning.inputs, target: 15 });
  planning.builds = planning.builds.filter(b => b.kind !== 'road');
  const d = p.decide({ planning, hasYearOfPlenty: true });
  expect(d).toMatchObject({ kind: 'play-year-of-plenty', resources: ['ore', 'ore'], funding: { kind: 'city' } });
  me.hand.ore += 2;
  expect(p.decide({ planning, funding: d!.funding })?.kind).toBe('build-city');
});
it.each([78, 84])('converts surplus to the city reserve instead of another dev at decision %s', source => {
  const p = position(source, true);
  expect(p.decide()).toMatchObject({ kind: 'bank-trade', trade: { get: 'ore' }, funding: { kind: 'city', partial: true } });
});
it('does not award Longest Road for a five-road tie at 3/4/11', () => {
  const p = position(55), target = p.planning.options.find(b => b.vertexId === 33)!;
  const trial = { ...p.gs.state, roads: [...p.gs.state.roads, ...target.roadEdges!.map(edgeId => ({ edgeId, player: p.gs.youPlayer }))] };
  expect(longestRoad(trial, p.gs.youPlayer)).toBe(5);
  expect(p.planning.inputs.find(p => !p.isYou)!.longestRoadLen).toBe(5);
  expect(target.vp).toBe(1);
});
it('values denying the opponent’s connected settlement site at 3/4/11', () => {
  const p = position(55);
  const contested = p.planning.options.find(b => b.vertexId === 33)!;
  expect(contested.disruptionValue).toBeGreaterThan(0);
  // The port does not deny a legal connected opponent settlement site.
  expect(p.planning.options.find(b => b.vertexId === 5)!.disruptionValue ?? 0).toBe(0);
});
it('does not chase an opponent-held road award before the winning plan needs it', () => {
  const p = position(55);
  expect(p.planning.options.some(b => b.kind === 'road' && b.vp === 2)).toBe(false);
  expect(p.decide({ hasRoadBuilding: true })?.funding?.kind).not.toBe('road');
});

it('uses the verified road transfer when its two VP complete the 15-point plan', () => {
  const p = closingPosition(55);
  expect(p.decide({ planning: p.planning, hasRoadBuilding: true })).toMatchObject({ kind: 'play-road-building', funding: { kind: 'road' } });
  const road = p.planning.options.find(b => b.kind === 'road')!;
  expect(road.roadEdges).toHaveLength(3);
  const trial = { ...p.gs.state, roads: [...p.gs.state.roads, ...road.roadEdges!.map(edgeId => ({ edgeId, player: p.gs.youPlayer }))] };
  expect(longestRoad(trial, p.gs.youPlayer)).toBe(6);
  expect(road.vp).toBe(2);
});
it('uses Year of Plenty for an immediately funded road-award transfer near victory', () => {
  const p = closingPosition(92), d = p.decide({ planning: p.planning, hasYearOfPlenty: true });
  expect(d).toMatchObject({ kind: 'play-year-of-plenty', funding: { kind: 'road' } });
  const me = p.tracker.players.get(captured.you)!;
  for (const resource of d!.resources!) me.hand[resource]++;
  expect(p.decide({ planning: p.planning, funding: d!.funding })?.kind).toBe('build-road');
});

it('executes both free roads and the paid road without abandoning the award plan', () => {
  const p = closingPosition(55), me = p.tracker.players.get(captured.you)!;
  let funding = p.decide({ planning: p.planning, hasRoadBuilding: true })!.funding;
  for (const freeRoadsPending of [2, 1, 0]) {
    const planning = planPosition(p.tracker, captured.you, p.gs, { target: 15,
      inputs: p.planning.inputs.map(player => ({ ...player,
        hand: player.isYou ? me.hand : player.hand,
        longestRoadLen: longestRoad(p.gs.state, player.playerId as 0 | 1),
        settlementRoutes: settlementRoutes(p.gs.state, player.playerId as 0 | 1),
        longestRoadPath: player.isYou ? roadBonusPath(p.gs.state, p.gs.youPlayer, 6, 10) : player.longestRoadPath,
      })) });
    const d = p.decide({ planning, freeRoadsPending, funding });
    expect(d?.kind).toBe('build-road');
    const edge = p.gs.state.board.edges.find(e => JSON.stringify(pixelsToColonistEdge(
      p.gs.state.board.vertices[e.a], p.gs.state.board.vertices[e.b])) === JSON.stringify(d!.coord))!;
    expect(edge).toBeDefined();
    expect(p.gs.state.roads.some(r => r.edgeId === edge.id)).toBe(false);
    p.gs.state.roads.push({ edgeId: edge.id, player: p.gs.youPlayer });
    if (!freeRoadsPending) { me.hand.wood--; me.hand.brick--; }
    // The executor clears a road-kind commitment after each confirmed road.
    funding = undefined;
  }
  expect(longestRoad(p.gs.state, p.gs.youPlayer)).toBe(6);
  expect(me.hand.wood).toBe(1);
  expect(me.hand.brick).toBe(0);
});

// Synthetic near-win control: same geometry and hand, but two VP from 15.
function closingPosition(source: number) {
  const p = position(source);
  const me = p.planning.inputs.find(player => player.isYou)!;
  me.publicVp = 13; me.hiddenVp = 0;
  p.tracker.players.get(captured.you)!.serverVp = 13;
  p.planning = planPosition(p.tracker, captured.you, p.gs, { target: 15, inputs: p.planning.inputs });
  return p;
}
