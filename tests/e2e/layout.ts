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

/** Where a phrase inside an element is drawn: whether it is there, and whether every part of it shows. */
export interface PhraseShown {
  found: boolean;
  /**
   * Every line box of the phrase lies inside the window and inside each box around it that clips its content, and no
   * fixed or sticky bar (the masthead, the bottom bar) is drawn over it.
   */
  inside: boolean;
  /** The phrase is not hidden, transparent or drawn in a transparent colour. */
  painted: boolean;
  fontSize: number;
}

/**
 * Whether `phrase` in `el`'s text is drawn where the owner can read it, measured from its own line boxes rather than
 * from the accessible name: a line clamp, an ellipsis or a box that clips would hide the words while the name still
 * has them. Runs inside the page with `locator.evaluate(phraseShown, phrase)`, so it uses nothing from outside.
 */
export function phraseShown(el: Element, phrase: string): PhraseShown {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = (node.textContent ?? "").indexOf(phrase);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + phrase.length);
    const lines = [...range.getClientRects()].filter((r) => r.width > 0);
    const holder = node.parentElement!;
    const clips: DOMRect[] = [new DOMRect(0, 0, document.documentElement.clientWidth, window.innerHeight)];
    for (let box: Element | null = holder; box; box = box.parentElement) {
      const style = getComputedStyle(box);
      if (style.overflowX !== "visible" || style.overflowY !== "visible" || style.webkitLineClamp !== "none") clips.push(box.getBoundingClientRect());
    }
    const within = (r: DOMRect, c: DOMRect) => r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && r.top >= c.top - 0.5 && r.bottom <= c.bottom + 0.5;
    const pinned = (box: Element) => ["fixed", "sticky"].includes(getComputedStyle(box).position) && !box.contains(holder);
    const covered = (x: number, y: number) => {
      for (let hit = document.elementFromPoint(x, y); hit; hit = hit.parentElement) if (pinned(hit)) return true;
      return false;
    };
    const uncovered = (r: DOMRect) => [r.left + 1, (r.left + r.right) / 2, r.right - 1].every((x) => !covered(x, (r.top + r.bottom) / 2));
    const style = getComputedStyle(holder);
    let opaque = true;
    for (let box: Element | null = holder; box; box = box.parentElement) if (parseFloat(getComputedStyle(box).opacity) === 0) opaque = false;
    const colour = style.color.match(/[\d.]+/g)?.map(Number) ?? [];
    return {
      found: true,
      inside: lines.length > 0 && lines.every((r) => clips.every((c) => within(r, c)) && uncovered(r)),
      painted: opaque && style.visibility === "visible" && (colour.length < 4 || colour[3]! > 0),
      fontSize: parseFloat(style.fontSize),
    };
  }
  return { found: false, inside: false, painted: false, fontSize: 0 };
}

/** A field's placeholder width in the field's own font, against the room the field gives it. */
export function placeholderFit(input: HTMLInputElement): { text: number; room: number } {
  const style = getComputedStyle(input);
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return { text: ctx.measureText(input.placeholder).width, room: input.clientWidth };
}
