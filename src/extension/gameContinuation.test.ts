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
