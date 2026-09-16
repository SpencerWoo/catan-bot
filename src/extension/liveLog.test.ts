import { expect, it, vi } from 'vitest';
import { STATE_EVENT } from './stateBridge';

it('ingests server events once, repairs Monopoly evidence, and replaces history on a new INIT', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
  document.body.innerHTML = '<div id="log"><div data-index="0">loading</div></div>';
  localStorage.clear();
  await import('./content');
  const send = (type: number, payload: unknown) => window.dispatchEvent(new MessageEvent('message', {
    data: {__catan_copilot__:true,type,payload}
  }));
  const gameState = {
    playerStates: {'5':{resourceCards:{cards:[1,2,3]}},'2':{resourceCards:{cards:[0,0,0]}}},
    gameLogState: {
      '0':{text:{type:2}},
      '9':{text:{type:47,playerColor:2,cardsToBroadcast:[4,4,5],distributionType:0}},
      '13':{text:{type:47,playerColor:5,cardsToBroadcast:[1,2,3],distributionType:0}},
      '16':{text:{type:10,playerColor:5,firstDice:3,secondDice:5}},
    }
  };
  const init = { playerColor:5, playerUserStates:[{username:'Us',selectedColor:5},{username:'Them',selectedColor:2}],gameState };
  send(STATE_EVENT.INIT,init);
  await vi.advanceTimersByTimeAsync(2500);
  expect(document.body.textContent).toContain('1 observed rolls');
  const saved = () => JSON.parse(localStorage.getItem(`catanCopilot:ledger:${location.href}`)!);
  expect(saved().source).toBe('server');
  expect(saved().complete).toBe(true);
  expect(saved().snapshot).toEqual({mine:{wood:1,brick:1,sheep:1,wheat:0,ore:0},opponentTotal:3});
  const diff = { gameLogState:{'20':{text:{type:10,playerColor:2,firstDice:4,secondDice:5}}} };
  send(STATE_EVENT.DIFF,{diff}); send(STATE_EVENT.DIFF,{diff});
  await vi.advanceTimersByTimeAsync(400);
  expect(document.body.textContent).toContain('2 observed rolls');
  expect(saved().events.filter(([,e]: [number,{type:string}]) => e.type==='roll')).toHaveLength(2);
  // A recycled DOM index belongs to another namespace; it cannot overwrite a server event.
  document.querySelector('[data-index]')!.innerHTML = '<span style="font-weight:600">Us</span> rolled <img alt="dice_1"><img alt="dice_1">';
  await vi.advanceTimersByTimeAsync(400);
  expect(saved().events.filter(([,e]: [number,{type:string}]) => e.type==='roll')).toHaveLength(2);
  send(STATE_EVENT.INIT,{...init,gameState:{...gameState,gameLogState:{'0':{text:{type:2}}}}});
  await vi.advanceTimersByTimeAsync(400);
  expect(document.body.textContent).toContain('0 observed rolls');
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});
