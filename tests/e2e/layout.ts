/** Layout measurements the journeys share; each runs inside the page with `locator.evaluate`. */

/** The first character of every line an element's text runs onto. */
export function lineStarts(el: Element): string[] {
  const starts = new Map<number, { left: number; char: string }>();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    for (let i = 0; i < text.length; i++) {
      if (!text[i]!.trim()) continue;
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const box = range.getBoundingClientRect();
      const line = Math.round(box.top);
      const first = starts.get(line);
      if (!first || box.left < first.left) starts.set(line, { left: box.left, char: text[i]! });
    }
  }
  return [...starts.values()].map((s) => s.char);
}
