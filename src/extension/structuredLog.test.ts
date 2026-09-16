import { expect, it } from 'vitest';
import frames from './__fixtures__/wire-game-log.json';
import { parseStructuredLog, StructuredLogEntry } from './structuredLog';
import { HandLedger, confirmedMonopolyHaul } from './handLedger';
import { applyEvent, createTracker } from './tracker';

const names = new Map([[5, 'Us'], [2, 'Them']]);
it('recovers every captured roll and starting hand regardless of DOM virtualization or private-ID gaps', () => {
  const entries = new Map<number, StructuredLogEntry>();
  for (const frame of frames) for (const [id, entry] of Object.entries(frame.logs)) entries.set(+id, entry);
  const tracker = createTracker('Us');
  for (const [, entry] of [...entries].sort(([a], [b]) => a-b)) {
    const event = parseStructuredLog(entry, names, 'Us');
    expect(event).not.toBeNull();
    applyEvent(tracker, event!);
  }
  expect(tracker.rolls).toHaveLength(66);
  expect(tracker.gameOver).toBe('Them');
});
it('restores exact Monopoly evidence from opening events missing from the DOM capture', () => {
  const ledger = new HandLedger('Us', 'Them', true);
  const entries = new Map<number, StructuredLogEntry>();
  for (const frame of frames) for (const [id, entry] of Object.entries(frame.logs)) if (+id <= 18) entries.set(+id, entry);
  for (const [id, entry] of entries) ledger.record(id, parseStructuredLog(entry, names, 'Us')!);
  const mine = {wood:0,brick:1,sheep:1,wheat:1,ore:0};
  const result = ledger.project({mine, opponentTotal:4});
  expect(result).toMatchObject({health:'exact',opponent:{wood:0,brick:0,sheep:0,wheat:3,ore:1}});
  expect(confirmedMonopolyHaul([{name:'Them',hand:result.opponent!,serverCards:4,trackingHealth:result.health}], 'Us','wheat')).toBe(3);
});
it('does not silently accept unknown resource events or invalid dice', () => {
  expect(parseStructuredLog({text:{type:999,playerColor:2}}, names,'Us')).toBeNull();
  expect(parseStructuredLog({text:{type:10,playerColor:2,firstDice:7,secondDice:2}}, names,'Us')).toBeNull();
});
it('keeps the full captured game ledger exact through steals, free roads, trades and Monopoly', () => {
  const ledger = new HandLedger('Us', 'Them', true);
  const hands: Record<string, number[]> = {};
  const resource = ['wood','brick','sheep','wheat','ore'] as const;
  let last: ReturnType<HandLedger['project']> | undefined;
  for (const frame of frames) {
    for (const [id, entry] of Object.entries(frame.logs)) ledger.record(+id, parseStructuredLog(entry, names, 'Us')!);
    Object.assign(hands, frame.hands);
    if (!hands['5'] || !hands['2']) continue;
    const mine = Object.fromEntries(resource.map((r,i)=>[r,hands['5'].filter(c=>c===i+1).length])) as import('../engine/winnability').Hand;
    last = ledger.project({mine,opponentTotal:hands['2'].length});
  }
  expect(last?.health).toBe('exact');
});
