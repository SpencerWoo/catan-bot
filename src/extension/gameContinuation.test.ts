// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GameContinuation } from "./gameContinuation";

beforeEach(() => {
  document.body.innerHTML = '<button>Continue</button>';
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 40 } as DOMRect);
});

describe('game-end continuation', () => {
  it('requires enabled autoplay and a saved result', () => {
    const continuation = new GameContinuation();
    const click = vi.spyOn(document.querySelector('button')!, 'click');
    expect(continuation.tick(false, true, 'game1')).toBe(false);
    expect(continuation.tick(true, false, 'game1')).toBe(false);
    expect(click).not.toHaveBeenCalled();
    expect(continuation.tick(true, true, 'game1')).toBe(true);
    expect(click).toHaveBeenCalledOnce();
  });

  it('clicks once through repeated ticks, DOM replacement, and toggle changes', () => {
    const continuation = new GameContinuation();
    continuation.tick(true, true, 'game1');
    document.body.innerHTML = '<button>Continue</button>';
    const click = vi.spyOn(document.querySelector('button')!, 'click');
    continuation.tick(false, true, 'game1');
    expect(continuation.tick(true, true, 'game1')).toBe(false);
    expect(click).not.toHaveBeenCalled();
    expect(continuation.tick(true, true, 'game2')).toBe(true);
    expect(click).toHaveBeenCalledOnce();
  });

  it.each([
    '', '<button disabled>Continue</button>',
    '<button aria-disabled="true">Continue</button>',
    '<div hidden><button>Continue</button></div>',
    '<button style="visibility:hidden">Continue</button>',
    '<div data-index="5"><button>Continue</button></div>',
    '<div id="catan-copilot"><button>Continue</button></div>',
    '<button>Continue shopping</button>',
  ])('waits for a usable results button: %s', html => {
    const continuation = new GameContinuation();
    document.body.innerHTML = html;
    expect(continuation.tick(true, true, 'game1')).toBe(false);
    document.body.innerHTML = '<div role="button" aria-label="Continue"></div>';
    expect(continuation.tick(true, true, 'game1')).toBe(true);
  });
});

it('advances through Continue, summary Play, and optional prompt Play exactly once', () => {
  const continuation = new GameContinuation();
  const tick = () => continuation.tick(true, true, 'game1');
  expect(tick()).toBe(true);
  document.body.innerHTML = '<button>Home</button><button id="summary">Play</button>';
  const summary = vi.spyOn(document.querySelector<HTMLElement>('#summary')!, 'click');
  expect(tick()).toBe(true);
  expect(tick()).toBe(false);
  expect(summary).toHaveBeenCalledOnce();
  document.body.innerHTML += '<section><h2>Explore new worlds</h2><button id="prompt">Play</button><button>Subscribe</button></section>';
  const prompt = vi.spyOn(document.querySelector<HTMLElement>('#prompt')!, 'click');
  expect(continuation.tick(false, true, 'game1')).toBe(false);
  expect(tick()).toBe(true);
  expect(tick()).toBe(false);
  expect(prompt).toHaveBeenCalledOnce();
});

it('does not click unrelated Play buttons or skip Continue', () => {
  const continuation = new GameContinuation();
  document.body.innerHTML = '<button>Play</button>';
  expect(continuation.tick(true, true, 'game1')).toBe(false);
  document.body.innerHTML = '<button>Continue</button>';
  continuation.tick(true, true, 'game1');
  document.body.innerHTML = '<button>Play</button>';
  expect(continuation.tick(true, true, 'game1')).toBe(false);
});

it('waits for summary controls and does not repeat Play when no prompt appears', () => {
  const continuation = new GameContinuation();
  continuation.tick(true, true, 'game1');
  document.body.innerHTML = '<button>Home</button><button disabled>Play</button>';
  expect(continuation.tick(true, true, 'game1')).toBe(false);
  document.querySelector('button[disabled]')!.removeAttribute('disabled');
  expect(continuation.tick(false, true, 'game1')).toBe(false);
  expect(continuation.tick(true, true, 'game1')).toBe(true);
  document.body.innerHTML = '<button>Home</button><button>Play</button>';
  expect(continuation.tick(true, true, 'game1')).toBe(false);
  document.body.innerHTML = '<button>Continue</button>';
  expect(continuation.tick(true, true, 'game2')).toBe(true);
});

it('continues without focus while the document is in a background tab', () => {
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  try {
    const continuation = new GameContinuation();
    expect(continuation.tick(true, true, 'background-game')).toBe(true);
    document.body.innerHTML = '<button>Home</button><button>Play</button>';
    expect(continuation.tick(true, true, 'background-game')).toBe(true);
    document.body.innerHTML = '<section><h2>Explore new worlds</h2><button>Play</button></section>';
    expect(continuation.tick(true, true, 'background-game')).toBe(true);
  } finally { focus.mockRestore(); visibility.mockRestore(); }
});
