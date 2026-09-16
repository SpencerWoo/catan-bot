import { expect, it } from 'vitest';
import klute from './__fixtures__/latest-games/klute-endgame.json';
import { replayDecision } from './replay';
import { GameLog } from './gameLog';

it('defends the held road bonus in the recorded Klute position instead of saving for a city', () => {
  const result = replayDecision(klute as GameLog, 1);
  expect(result.decision?.kind).toBe('build-road');
  expect(result.decision?.describe).toContain('defend');
});

import { replayPlanning } from './replay';
import { longestRoad, planPosition, roadDefensePath } from './planning';
import { decideNext } from './autopilot';
import { rankLiveStrategies } from './copilot';

it('funds a real connected retaining extension without counting it as newly earned VP', () => {
  const replay = replayPlanning(klute as GameLog, 1, true);
  const defense = replay.planning!.builds.find(b => b.protectsBonus)!;
  expect(defense).toBeDefined();
  expect(defense.vp).toBe(0);
  expect(defense.wait).toBe(0);
  const {state,youPlayer} = replay.gs!;
  const after = {...state, roads:[...state.roads,...defense.roadEdges!.map(edgeId=>({edgeId,player:youPlayer}))]};
  expect(longestRoad(after,youPlayer)).toBeGreaterThanOrEqual(11);
  expect(roadDefensePath(state,replay.planning!.inputs.map(p=>p.isYou?{...p,roadsLeft:0}:p),15)).toBeNull();
  expect(roadDefensePath(state,replay.planning!.inputs.map(p=>!p.isYou?{...p,publicVp:2,hiddenVp:0}:p),15)).toBeNull();
});

it('uses Monopoly to fund an immediate winning city before defending roads', () => {
  const replay = replayPlanning(klute as GameLog, 1, true);
  const {tracker,gs} = replay;
  const you = tracker!.players.get(klute.you)!;
  const them = [...tracker!.players.values()].find(p=>p.name!==klute.you)!;
  you.hand = {wood:2,brick:2,sheep:0,wheat:2,ore:2}; you.serverVp = 14;
  them.hand = {wood:0,brick:0,sheep:0,wheat:0,ore:1}; them.serverCards=1; them.trackingHealth='exact';
  const inputs = replay.planning!.inputs.map(p=>({...p,hand:p.isYou?you.hand:them.hand,
    publicVp:p.isYou?14:p.publicVp,hiddenVp:p.isYou?0:p.hiddenVp}));
  const planning = planPosition(tracker!,klute.you,gs!,{inputs,target:15});
  const decision = decideNext({tracker:tracker!,youName:klute.you,gs:gs!,planning,
    fit:rankLiveStrategies(tracker!,klute.you)[0],advice:null,rolledThisTurn:true,hasMonopoly:true});
  expect(decision).toMatchObject({kind:'play-monopoly',resource:'ore'});
  expect(decision!.describe).toContain('victory now');
});
