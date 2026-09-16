/** Virtualized rows may be recycled or have text/icons filled in later.
 * Reparse their enclosing row for every relevant mutation, once per batch. */
export function observeGameLog(scroller: HTMLElement, process: (row: Element) => void): MutationObserver {
  const observer = new MutationObserver(mutations => {
    const rows = new Set<Element>();
    const collect = (node: Node): void => {
      const element = node.nodeType === 1 ? node as Element : node.parentElement;
      if (!element || !scroller.contains(element)) return;
      const row = element.closest('[data-index]');
      if (row) rows.add(row);
      element.querySelectorAll('[data-index]').forEach(row => rows.add(row));
    };
    for (const m of mutations) {
      collect(m.target);
      m.addedNodes.forEach(collect);
    }
    for (const row of rows) process(row);
  });
  observer.observe(scroller, { childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['data-index', 'alt'] });
  return observer;
}
