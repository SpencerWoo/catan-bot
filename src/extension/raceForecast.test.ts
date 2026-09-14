import { expect, it } from 'vitest';
import { Overlay } from './overlay';
import { createTracker } from './tracker';
import { VictoryPlan } from '../engine/winnability';

it('shows completion time rather than an uncalibrated 98% win claim', () => {
  document.body.innerHTML = '';
  const plan: VictoryPlan = { name: 'Us', isYou: true, publicVp: 8, target: 15,
    eliminated: false, steps: [], planVp: 7, need: {}, turnsToWin: 3.4, winProb: 0.98,
    largestArmyReachable: false, longestRoadReachable: false, summary: 'city plan' };
  const overlay = new Overlay(document, { getWinChances: () => [plan] });
  overlay.render(createTracker('Us'));
  const root = document.getElementById('catan-copilot')!;
  expect(root.textContent).toContain('~3.4 own turns');
  expect(root.textContent).not.toContain('98%');
  expect(root.textContent).toContain('not win odds');
  plan.eliminated = true;
  overlay.render(createTracker('Us'));
  expect(root.textContent).toContain('No verified route');
});
