/** Layout measurements the journeys share; most run inside the page with `locator.evaluate`. */
import type { Locator } from "@playwright/test";

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

/** A field's placeholder width in the placeholder's own font and letter spacing, against the field's content box. */
export function placeholderFit(input: HTMLInputElement): { text: number; room: number } {
  const style = getComputedStyle(input, "::placeholder");
  const box = getComputedStyle(input);
  const ctx = document.createElement("canvas").getContext("2d")!;
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  ctx.letterSpacing = style.letterSpacing === "normal" ? "0px" : style.letterSpacing;
  return { text: ctx.measureText(input.placeholder).width, room: input.clientWidth - parseFloat(box.paddingLeft) - parseFloat(box.paddingRight) };
}

/**
 * Marks one character of `phrase` (at `index`) in `el`'s text: with `hide` its glyph turns transparent through a CSS
 * highlight (nothing moves and the DOM is untouched), without it the mark is lifted. Returns that character's box
 * inside the window, or null when it has none there. Runs inside the page.
 */
function markGlyph(el: Element, [phrase, index, hide]: readonly [string, number, boolean]): { x: number; y: number; width: number; height: number } | null {
  const NAME = "phrase-drawn";
  if (!document.getElementById(NAME)) {
    const style = document.createElement("style");
    style.id = NAME;
    style.textContent = `::highlight(${NAME}) { color: transparent; }`;
    document.head.append(style);
  }
  CSS.highlights.delete(NAME);
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = (node.textContent ?? "").indexOf(phrase);
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at + index);
    range.setEnd(node, at + index + 1);
    if (hide) CSS.highlights.set(NAME, new Highlight(range));
    const box = range.getBoundingClientRect();
    const left = Math.max(0, Math.floor(box.left));
    const top = Math.max(0, Math.floor(box.top));
    const right = Math.min(document.documentElement.clientWidth, Math.ceil(box.right));
    const bottom = Math.min(window.innerHeight, Math.ceil(box.bottom));
    return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
  }
  return null;
}

/**
 * Whether the owner sees `phrase` in `el`, by its pixels: hiding each of its glyphs on its own must change the picture
 * where that glyph sits. A glyph that is clipped (even only the last digit), painted over by any layer or drawn
 * invisibly changes nothing. Pair it with `phraseShown`, which asks that the phrase lies inside what clips it.
 */
export async function phraseDrawn(el: Locator, phrase: string): Promise<boolean> {
  const page = el.page();
  const shot = { animations: "disabled", caret: "hide" } as const;
  for (let i = 0; i < phrase.length; i++) {
    if (!phrase[i]!.trim()) continue;
    const clip = await el.evaluate(markGlyph, [phrase, i, false] as const);
    if (!clip) return false;
    const shown = await page.screenshot({ clip, ...shot });
    await el.evaluate(markGlyph, [phrase, i, true] as const);
    const hidden = await page.screenshot({ clip, ...shot });
    await el.evaluate(markGlyph, [phrase, i, false] as const);
    if (shown.equals(hidden)) return false;
  }
  return true;
}

/** Whether a field's placeholder paints: the field looks different once its placeholder is taken away. */
export async function placeholderDrawn(input: Locator): Promise<boolean> {
  const page = input.page();
  await input.scrollIntoViewIfNeeded();
  const box = (await input.boundingBox())!;
  const clip = { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) };
  const shot = { clip, animations: "disabled", caret: "hide" } as const;
  const shown = await page.screenshot(shot);
  const placeholder = await input.evaluate((el: HTMLInputElement) => {
    const was = el.placeholder;
    el.placeholder = "";
    return was;
  });
  const bare = await page.screenshot(shot);
  await input.evaluate((el: HTMLInputElement, was) => (el.placeholder = was), placeholder);
  return !shown.equals(bare);
}
