import { expect, it } from 'vitest';
import captured from './__fixtures__/latest-games/ch4y-roads.json';
import { GameLog } from './gameLog';
import { replayDecision } from './replay';
import { pixelsToColonistEdge } from './coords';

const log = captured as unknown as GameLog;
for (const [index, edgeId] of [[0, 63], [1, 69], [2, 65]]) {
  it(`does not repeat the unfunded contested road in ch4y decision ${captured.decisions[index].sourceDecision}`, () => {
    const result = replayDecision(log, index);
    const board = result.gs!.state.board;
    const edge = board.edges[edgeId];
    expect(result.decision).not.toMatchObject({ kind: 'build-road',
      coord: pixelsToColonistEdge(board.vertices[edge.a], board.vertices[edge.b]) });
  });
}

import { GameState } from '../engine/types';
import { reachableRoadPath, spotContest } from './placement';
import { settlementRoadThreats, opponentCutSites } from './roadContest';
import { longestRoad, roadBonusPath } from './planning';
import { decideNext } from './autopilot';
import { rankLiveStrategies } from './copilot';
import { evaluateBuilds } from '../engine/horizon';

function graph(pairs: number[][]): GameState {
  const vertices = Array.from({ length: 1 + Math.max(...pairs.flat()) }, (_, id) => ({
    id, x: id, y: 0, hexIds: [], port: null,
    adjacent: pairs.filter(p => p.includes(id)).map(p => p[0] === id ? p[1] : p[0]),
  }));
  return { board: { seed: 0, hexes: [], vertices, edges: pairs.map(([a,b],id) => ({id,a,b})) }, buildings: [], roads: [] };
}

it('distinguishes direct access from an unreachable opponent', () => {
  const state = graph([[0,1],[1,2],[2,3],[4,5]]);
  state.buildings = [{player:0,vertexId:0,kind:'settlement'}, {player:1,vertexId:5,kind:'settlement'}];
  state.roads = [{player:0,edgeId:0},{player:1,edgeId:2}];
  expect(reachableRoadPath(state,1,2)).toEqual([]);
  expect(spotContest(state,0,2)).toMatchObject({losing:true,oppLen:0});
  state.roads.pop();
  expect(reachableRoadPath(state,1,2)).toBeNull();
  expect(spotContest(state,0,2).oppLen).toBeNull();
});

it('detects adjacent settlement exclusions and intermediate cuts, respecting the distance rule', () => {
  const state = graph([[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[2,7],[7,8],[8,9],[5,10],[10,11]]);
  state.buildings = [{player:0,vertexId:0,kind:'settlement'}, {player:1,vertexId:9,kind:'settlement'}];
  state.roads = [{player:0,edgeId:0},{player:1,edgeId:6},{player:1,edgeId:9}];
  const threats = settlementRoadThreats(state,0,4,[1,2,3]);
  expect(threats).toContainEqual({opponent:1,vertexId:2,roadsNeeded:0,reason:'route-cut'});
  expect(threats).toContainEqual({opponent:1,vertexId:5,roadsNeeded:0,reason:'adjacent-settlement'});
  state.buildings.push({player:0,vertexId:3,kind:'settlement'});
  expect(settlementRoadThreats(state,0,4,[1,2,3]).some(t => t.vertexId===2)).toBe(false);
});

it('chooses the equally short bonus extension that retains more road after a legal cut', () => {
  const state = graph([[0,1],[1,2],[2,3],[3,4],[4,5],[5,6],[2,7],[7,8],[8,9]]);
  state.buildings = [{player:0,vertexId:5,kind:'settlement'}, {player:1,vertexId:9,kind:'settlement'}];
  state.roads = [1,2,3,4].map(edgeId=>({edgeId,player:0 as const}));
  state.roads.push({edgeId:6,player:1},{edgeId:7,player:1});
  expect(opponentCutSites(state,0)).toEqual([{vertexId:2,player:1}]);
  expect(roadBonusPath(state,0,5,1)).toEqual([5]);
  const trial = {...state, roads:[...state.roads,{edgeId:5,player:0 as const}]};
  expect(longestRoad(trial,0)).toBe(5);
  expect(longestRoad({...trial,buildings:[...trial.buildings,{vertexId:2,player:1,kind:'settlement'}]},0)).toBe(4);
});

function roadDecision(hand: {wood:number;brick:number;sheep:number;wheat:number;ore:number},
  options: {free?:boolean; safe?:boolean; discardLimit?:number; freePending?:number} = {}) {
  const replay = replayDecision(log,1);
  const { tracker, gs, planning } = replay;
  const you = tracker!.players.get(log.you!)!;
  you.hand = hand; you.serverCards = Object.values(hand).reduce((a,b)=>a+b,0);
  if (options.safe) {
    gs!.state = {...gs!.state, roads:gs!.state.roads.filter(r=>r.player===gs!.youPlayer),
      buildings:gs!.state.buildings.filter(b=>b.player===gs!.youPlayer)};
  }
  planning!.options = planning!.options.filter(b=>b.kind==='settlement' && b.vertexId===48);
  planning!.builds = evaluateBuilds(planning!.options, hand, planning!.production, you.bankRatio,
    planning!.remaining, planning!.gap, planning!.horizon);
  return decideNext({tracker:tracker!,gs:gs!,planning:planning!,youName:log.you!,
    fit:rankLiveStrategies(tracker!,log.you!)[0],advice:null,rolledThisTurn:true,
    hasRoadBuilding:options.free,freeRoadsPending:options.freePending,discardLimit:options.discardLimit ?? 100});
}

it('allows fully funded contested claims and safe incremental expansion', () => {
  expect(roadDecision({wood:3,brick:3,sheep:1,wheat:1,ore:0})?.kind).toBe('build-road');
  expect(roadDecision({wood:1,brick:1,sheep:0,wheat:2,ore:0},{safe:true})?.kind).toBe('build-road');
});

it('does not bypass the commitment gate under discard pressure', () => {
  const action = roadDecision({wood:2,brick:2,sheep:0,wheat:3,ore:0},{discardLimit:4});
  expect(action?.kind).not.toBe('build-road');
  expect(action?.evaluation?.roadCommitments).toContainEqual(expect.objectContaining({
    vertexId:48,requiresFullFunding:true,funded:false,
  }));
});

it('requires the remaining settlement budget before playing free roads into a contest', () => {
  expect(roadDecision({wood:1,brick:1,sheep:0,wheat:2,ore:0},{free:true})?.kind).not.toBe('play-road-building');
  expect(roadDecision({wood:1,brick:1,sheep:1,wheat:1,ore:0},{free:true})?.kind).toBe('play-road-building');
  expect(roadDecision({wood:1,brick:1,sheep:1,wheat:1,ore:0},{freePending:2})?.kind).toBe('build-road');
});

it('drops a claimed target when replaying the next confirmed board state', () => {
  const changed = structuredClone(log);
  changed.decisions![1].position!.buildings.push({player:0,vertexId:48,kind:'settlement'});
  const replay = replayDecision(changed,1);
  expect(replay.planning!.options.some(b=>b.kind==='settlement' && b.vertexId===48)).toBe(false);
});

it('preserves the funded settlement target across staged road actions', () => {
  expect(roadDecision({wood:3,brick:3,sheep:1,wheat:1,ore:0})?.funding)
    .toEqual({kind:'settlement',vertexId:48});
});
