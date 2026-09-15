export const CONTINUATION_PREF = "catanCopilot:continueAutoplay";

export function loadContinuationPref(): boolean {
  try {
    const saved = localStorage.getItem(CONTINUATION_PREF);
    // Materialize the default so the standalone runner sees it too.
    if (saved === null) localStorage.setItem(CONTINUATION_PREF, "0");
    return saved === "1";
  } catch { return false; }
}

export function saveContinuationPref(on: boolean): void {
  try { localStorage.setItem(CONTINUATION_PREF, on ? "1" : "0"); }
  catch { /* The current tab still honors the in-memory choice. */ }
}
