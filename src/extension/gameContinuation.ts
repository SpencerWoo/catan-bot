/** Advance a saved game through results and into matchmaking. */
export class GameContinuation {
  private game: string | null = null;
  private stage: 'continue' | 'summary' | 'prompt' | 'done' = 'continue';

  tick(enabled: boolean, resultSaved: boolean, gameId: string, doc: Document = document): boolean {
    if (!enabled || !resultSaved) return false;
    if (this.game !== gameId) {
      this.game = gameId;
      this.stage = 'continue';
    }
    if (this.stage === 'done') return false;
    const buttons = [...doc.querySelectorAll<HTMLElement>('button, [role="button"]')].filter(el => {
      if (el.closest('[data-index], #catan-copilot, [hidden], [inert], [aria-hidden="true"], [aria-disabled="true"]')) return false;
      if (el.matches(':disabled')) return false;
      const rect = el.getBoundingClientRect();
      const style = doc.defaultView?.getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style?.visibility !== 'hidden' && style?.display !== 'none';
    });
    const named = (el: HTMLElement, label: string): boolean =>
      (el.getAttribute('aria-label') || el.textContent || '').trim().toLowerCase() === label;
    let button: HTMLElement | undefined;
    if (this.stage === 'continue') {
      button = buttons.find(el => named(el, 'continue'));
    } else if (this.stage === 'summary') {
      // Home + Play identifies the post-game summary, not a lobby or an ad.
      if (buttons.some(el => named(el, 'home'))) {
        button = buttons.find(el => named(el, 'play'));
      }
    } else {
      // The summary's Play may remain behind the optional promotion. Only
      // click the Play belonging to the "Explore new worlds" prompt.
      const headings = doc.querySelectorAll<HTMLElement>('h1, h2, h3, [role="heading"]');
      for (const heading of headings) {
        if (!/^explore new worlds\b/i.test(heading.textContent?.trim() ?? '')) continue;
        for (let parent = heading.parentElement; parent && parent !== doc.body; parent = parent.parentElement) {
          button = buttons.find(el => parent.contains(el) && named(el, 'play'));
          if (button) break;
        }
        if (button) break;
      }
    }
    if (!button) return false;
    // Advance before clicking: synchronous DOM changes must not repeat a step.
    this.stage = this.stage === 'continue' ? 'summary' : this.stage === 'summary' ? 'prompt' : 'done';
    button.click();
    return true;
  }
}
