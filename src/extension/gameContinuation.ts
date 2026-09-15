/** One continuation per finished game, even if the results DOM is rebuilt. */
export class GameContinuation {
  private clickedGame: string | null = null;

  tick(enabled: boolean, resultSaved: boolean, gameId: string, doc: Document = document): boolean {
    if (!enabled || !resultSaved || this.clickedGame === gameId) return false;
    const button = [...doc.querySelectorAll<HTMLElement>('button, [role="button"]')].find(el => {
      if (el.closest('[data-index], #catan-copilot, [hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]')) return false;
      if (el.matches(':disabled')) return false;
      if (!/^continue$/i.test((el.getAttribute('aria-label') || el.textContent || '').trim())) return false;
      const rect = el.getBoundingClientRect();
      const style = doc.defaultView?.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
    });
    if (!button) return false;
    // Set the latch before clicking: synchronous DOM changes must not retry it.
    this.clickedGame = gameId;
    button.click();
    return true;
  }
}
