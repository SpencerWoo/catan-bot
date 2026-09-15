import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CONTINUATION_PREF, loadContinuationPref, saveContinuationPref } from "./continuationPreference";
import { Overlay } from "./overlay";
import { Autopilot } from "./autopilot";
import { ProtocolLearner } from "./protocolLearner";
import { createTracker } from "./tracker";
import { GameContinuation } from "./gameContinuation";

beforeEach(() => { localStorage.clear(); document.body.innerHTML = ""; });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("defaults off independently of autoplay and persists each choice", () => {
  localStorage.setItem("catanCopilot:autopilotOn", "1");
  expect(loadContinuationPref()).toBe(false);
  expect(localStorage.getItem(CONTINUATION_PREF)).toBe("0");
  saveContinuationPref(true);
  expect(loadContinuationPref()).toBe(true);
  saveContinuationPref(false);
  expect(loadContinuationPref()).toBe(false);
  expect(localStorage.getItem("catanCopilot:autopilotOn")).toBe("1");
});

it("defaults off if browser storage is unavailable", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
  expect(loadContinuationPref()).toBe(false);
  expect(() => saveContinuationPref(true)).not.toThrow();
});

it.each([[false, false], [true, false], [false, true], [true, true]])(
  "keeps turn autoplay=%s and continuation=%s independent in the overlay", (playTurns, continueGames) => {
    const ap = new Autopilot(new ProtocolLearner());
    ap.setEnabled(playTurns);
    let continuation = continueGames;
    const overlay = new Overlay(document, { getAutopilotView: () => ap.view(),
      onToggleAutopilot: on => ap.setEnabled(on), getContinueAutoplay: () => continuation,
      onToggleContinueAutoplay: on => { continuation = on; saveContinuationPref(on); } });
    overlay.render(createTracker("Us"));
    const turns = document.querySelector<HTMLInputElement>('[data-act="toggle-autopilot"]')!;
    const games = document.querySelector<HTMLInputElement>('[data-act="toggle-continuation"]')!;
    expect(turns.checked).toBe(playTurns);
    expect(games.checked).toBe(continueGames);
    const machine = new GameContinuation();
    const save = vi.fn();
    machine.finish("game", save);
    const button = document.createElement("button"); button.textContent = "Continue";
    document.body.appendChild(button);
    vi.spyOn(button, "getBoundingClientRect").mockReturnValue({ width: 100, height: 40 } as DOMRect);
    expect(machine.tick(continuation, "game")).toBe(continueGames);
    expect(save).toHaveBeenCalledOnce();
    games.click();
    expect(continuation).toBe(!continueGames);
    expect(ap.enabled).toBe(playTurns);
    turns.click();
    expect(ap.enabled).toBe(!playTurns);
    expect(continuation).toBe(!continueGames);
  });
