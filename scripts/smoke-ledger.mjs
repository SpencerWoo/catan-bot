import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
const bundle = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
const init = JSON.parse(readFileSync(new URL('../src/extension/__fixtures__/capture-slice.json', import.meta.url), 'utf8')).init.payload;
init.playerColor = 1;
init.playOrder = [1, 2];
init.playerUserStates = init.playerUserStates.slice(0, 2);
init.playerUserStates[0].username = 'Nick'; init.playerUserStates[1].username = 'Ava';
init.gameState.playerStates = { 1: init.gameState.playerStates[1], 2: init.gameState.playerStates[2] };
init.gameState.playerStates[1].resourceCards.cards = [1, 1];
init.gameState.playerStates[2].resourceCards.cards = [0, 0, 0];
const dom = new JSDOM('<html><head></head><body><div class="web-header-username">Nick</div><div id="scroller"></div></body></html>',
  { url: 'https://colonist.io/ledger-test', runScripts: 'outside-only', pretendToBeVisual: true });
const { window: w } = dom;
w.structuredClone = structuredClone;
w.fetch = async () => { throw new Error('offline'); };
w.localStorage.setItem('catanCopilot:autopilotOn', '0');
const errors = [];
w.addEventListener('error', (e) => errors.push(e.message));
const name = (n) => `<span style="font-weight:600;color:#e27174">${n}</span>`;
const img = (alt) => `<img alt="${alt}" src="x.svg">`;
const row = (index, html) => { const el = w.document.createElement('div'); el.dataset.index = String(index); el.innerHTML = html; w.document.getElementById('scroller').append(el); return el; };
row(0, `${name('Nick')} placed a ${img('settlement')}`);
row(1, `${name('Ava')} placed a ${img('settlement')}`);
row(2, `${name('Nick')} received starting resources: ${img('lumber')}${img('lumber')}`);
row(3, `${name('Ava')} received starting resources: ${img('ore')}${img('ore')}${img('ore')}`);
w.eval(bundle);
const post = (type, payload) => w.postMessage({ __catan_copilot__: true, type, payload }, '*');
const wait = (ms = 550) => new Promise((r) => setTimeout(r, ms));
post(4, init); await wait(3000);
function opponent() {
  const tr = [...w.document.querySelectorAll('#catan-copilot tr')].find((r) => r.firstElementChild?.textContent.trim() === 'Ava');
  assert.ok(tr, 'opponent row: ' + w.document.getElementById('catan-copilot')?.textContent.slice(-2000));
  return { exact: tr.textContent.includes('exact'), hand: tr.nextElementSibling.querySelector('.cc-hand') };
}
assert.ok(opponent().exact, 'opening ledger exact: ' + w.localStorage.getItem('catanCopilot:ledger:https://colonist.io/ledger-test') + w.document.getElementById('catan-copilot').textContent.slice(-1100));
// Snapshot arrives first: do not pretend it agrees before the steal is logged.
post(91, { diff: { playerStates: { 1: { resourceCards: { cards: [1, 1, 5] } }, 2: { resourceCards: { cards: [0, 0] } } } } });
await wait(); assert.ok(!opponent().exact, 'snapshot-before-log needs repair');
const steal = row(4, `${name('Nick')} stole from ${name('Ava')}`);
await wait(); assert.ok(opponent().exact, 'missing icon recovered');
assert.ok(opponent().hand.querySelector('[aria-label="ore 2"]'));
w.document.getElementById('scroller').append(steal.cloneNode(true));
await wait(); assert.ok(opponent().exact, 'duplicate row not applied twice');
// Other direction: log arrives first.
row(5, `${name('Ava')} stole from ${name('Nick')}`);
await wait(); assert.ok(!opponent().exact, 'log-before-snapshot needs repair');
post(91, { diff: { playerStates: { 1: { resourceCards: { cards: [1, 5] } }, 2: { resourceCards: { cards: [0, 0, 0] } } } } });
await wait(); assert.ok(opponent().exact, 'opponent steal recovered');
assert.ok(opponent().hand.querySelector('[aria-label="wood 1"]'));
// Replacing the virtual scroller exercises journal recovery with only one row
// visible, the actual reconnect case that used to reset the event index.
const replacement = w.document.createElement('div'); replacement.id = 'scroller';
replacement.append(w.document.querySelector('[data-index="5"]').cloneNode(true));
w.document.getElementById('scroller').replaceWith(replacement);
await wait(3000); assert.ok(opponent().exact, 'retained history restores exact hand');
assert.deepEqual(errors, []);
console.log('SMOKE OK — both steal directions, reversed delivery, duplicate row, and reconnect preserve exact hands.');
w.close();
