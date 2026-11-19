/**
 * The accessibility passes' kit (#35 of spec #14): what a screen reader, a 320 px window, 200% zoom, forced colours
 * and reduced motion each meet on a screen, measured in the real browser.
 */
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

/** The WCAG 2.2 A and AA rules, plus axe's best practices for landmarks, headings and regions. */
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

/**
 * Every axe-core finding on the page as "rule: selector (summary)", so a failure names what to fix. Colour contrast is
 * measured by `apps/web/test/contrast.test.ts` on every token pair and is left to it here: axe cannot see through the
 * translucent row states and reports them as unknown.
 */
export async function axeFindings(page: Page): Promise<string[]> {
  // Evaluated over the DevTools protocol, which the Dashboard's Content Security Policy does not cover (a script tag would be refused).
  if (!(await page.evaluate(() => "axe" in window))) await page.evaluate(AXE_SOURCE);
  return page.evaluate(async (tags) => {
    const axe = (window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: Array<{ id: string; nodes: Array<{ target: string[]; failureSummary?: string }> }> }> } }).axe;
    const result = await axe.run(document, { runOnly: { type: "tag", values: tags }, rules: { "color-contrast": { enabled: false } }, resultTypes: ["violations"] });
    return result.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")} (${(n.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 160)})`));
  }, AXE_TAGS);
}

/** What scrolls or sticks out sideways on a screen. */
export interface Sideways {
  /** How far the document scrolls sideways. */
  document: number;
  /** How far the page's scroller scrolls sideways. */
  page: number;
  /** Visible elements that reach past the window's left or right edge outside a sideways scroller of their own. */
  outside: string[];
}

/**
 * Measures a screen for sideways scrolling: the document and `.page` must not scroll sideways, and nothing the owner
 * can see may reach past the window's edges. Rows of chips and tabs that scroll on their own (`overflow-x: auto`) are
 * one control each and may hold more than fits; screen-reader-only text and the skip link while unfocused are left out.
 */
export function sideways(): Sideways {
  const width = document.documentElement.clientWidth;
  const scroller = document.querySelector<HTMLElement>(".page");
  const scrollsSideways = (el: Element) => /auto|scroll/.test(getComputedStyle(el).overflowX);
  const insideScroller = (el: Element) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (scrollsSideways(p) && !p.classList.contains("page")) return true;
    return false;
  };
  const outside: string[] = [];
  for (const el of document.querySelectorAll<HTMLElement>("body *")) {
    const box = el.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) continue;
    if (el.closest(".sr-only, .skip-link:not(:focus)")) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "contents") continue;
    if (box.right <= width + 0.5 && box.left >= -0.5) continue;
    if (insideScroller(el)) continue;
    const name = `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${[...el.classList].map((c) => `.${c}`).join("")}`;
    outside.push(`${name} [${Math.round(box.left)}, ${Math.round(box.right)}] "${(el.textContent ?? "").trim().slice(0, 40)}"`);
  }
  return {
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    page: scroller ? scroller.scrollWidth - scroller.clientWidth : 0,
    outside,
  };
}

/** The smallest touch target the design allows on a phone or with a coarse pointer, in CSS px (WCAG 2.5.5's enhanced size). */
export const TARGET = 44;

export interface Target {
  name: string;
  width: number;
  height: number;
  /** Where the browser sends a tap at the box's centre and just inside each corner: true when every one reaches it. */
  hit: boolean;
  /** Its words run past its own box, so part of them is cut off or spills onto a neighbour. */
  clipped: boolean;
  /** Document coordinates (every scrolled ancestor's offset added back, down and sideways), so boxes measured at different scroll positions compare. */
  box: { left: number; top: number; right: number; bottom: number };
  /** The scroller it moves with, or the fixed bar it sits in: boxes compare only within one layer. */
  layer: string;
}

/**
 * Every visible control inside `scope`, measured where it is drawn after scrolling it into view: its box, and whether
 * a tap anywhere in the box reaches it rather than a neighbour or a bar drawn over it. A link inside a sentence is part
 * of the text, not a target of its own (WCAG 2.5.8's inline exception); a checkbox is tapped on its label's line; a
 * control stretched over its line (an Inbox subject) is tapped anywhere in that line; controls hidden from assistive
 * technology are pointer shortcuts (the tab row's arrows) and left out. Run with `page.evaluate(targets, scope)`.
 */
export function targets(scope: string): Target[] {
  const controls = [...document.querySelectorAll<HTMLElement>(`:is(${scope}) :is(a[href], button, summary, select, input, textarea)`)].filter(
    (el) =>
      // Drawn: not hidden, and not inside a closed disclosure (whose content keeps its boxes but is not rendered).
      el.checkVisibility({ visibilityProperty: true }) &&
      !el.closest(".sr-only, [aria-hidden='true']") &&
      !(el.tagName === "A" && el.closest("p, dd, .fact-value")) &&
      !(el instanceof HTMLInputElement && el.type === "hidden"),
  );
  return controls.map((el) => {
    el.scrollIntoView({ block: "center" });
    const label = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio") ? el.labels?.[0] : null;
    const stretched = getComputedStyle(el, "::after").position === "absolute" && el.offsetParent;
    const drawn = label ?? (stretched ? (el.offsetParent as HTMLElement) : el);
    const r = drawn.getBoundingClientRect();
    // Just inside each corner: past the rounded-off part of its own rounded corner, or of a rounded card that clips
    // it, where a tap does not reach the control.
    const clips = [drawn, ...[drawn.parentElement, drawn.parentElement?.parentElement, drawn.parentElement?.parentElement?.parentElement].filter((p): p is HTMLElement => !!p && getComputedStyle(p).overflow !== "visible")];
    const radius = Math.max(...clips.map((c) => parseFloat(getComputedStyle(c).borderTopLeftRadius) || 0));
    const inset = Math.min(Math.ceil(radius * (1 - Math.SQRT1_2)) + 1, r.width / 2, r.height / 2);
    const points = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + inset, r.top + inset],
      [r.right - inset, r.top + inset],
      [r.left + inset, r.bottom - inset],
      [r.right - inset, r.bottom - inset],
    ];
    const hit = points.every(([x, y]) => {
      const at = document.elementFromPoint(x!, y!);
      return at !== null && (at === el || el.contains(at) || (label !== null && label !== undefined && label.contains(at)));
    });
    let [top, left] = [r.top, r.left];
    for (let n = el.parentElement; n; n = n.parentElement) [top, left] = [top + n.scrollTop, left + n.scrollLeft];
    const layer = el.closest(".masthead, .bottom-bar, dialog, [aria-modal='true']") ?? el.closest(".page");
    // A field scrolls what is typed in it (a long Machine name): its contents are not words cut off.
    const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement;
    const name = (el.getAttribute("aria-label") ?? label?.textContent ?? el.textContent ?? (el as HTMLInputElement).placeholder ?? "").trim() || el.outerHTML.slice(0, 60);
    return { name, width: r.width, height: r.height, hit, clipped: !field && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).textOverflow !== "ellipsis", box: { left, top, right: left + r.width, bottom: top + r.height }, layer: layer?.className ?? "" };
  });
}

/** Two targets in one layer whose boxes share more than an edge. */
export const overlaps = (a: Target, b: Target) =>
  a.layer === b.layer && a.box.left < b.box.right - 0.5 && b.box.left < a.box.right - 0.5 && a.box.top < b.box.bottom - 0.5 && b.box.top < a.box.bottom - 0.5;

/** The focus ring the keyboard's focus shows: on the control, on its stretched line (`::after`), or around the box a field sits in. */
export interface Ring {
  name: string;
  style: string;
  width: number;
  /** The ring's colour, and the system's Highlight colour it should be under forced colours. */
  colour: string;
  highlight: string;
  /** Focus has been on this element before: the Tab order came back round. */
  visited: boolean;
  /** It sits in the masthead. */
  masthead: boolean;
}

/**
 * The focused element's ring, marking the element as visited. Run with `page.evaluate(focusRing)`; null when nothing in
 * the page has focus. A fresh page load clears the marks.
 */
export function focusRing(): Ring | null {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return null;
  const probe = document.createElement("span");
  probe.style.color = "Highlight";
  document.body.append(probe);
  const highlight = getComputedStyle(probe).color;
  probe.remove();
  const candidates = [getComputedStyle(el), getComputedStyle(el, "::after"), ...(el.closest(".search-box") ? [getComputedStyle(el.closest(".search-box")!)] : [])];
  const drawn = candidates.find((s) => s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) ?? candidates[0]!;
  const name = `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? (el as HTMLInputElement).labels?.[0]?.textContent ?? el.textContent ?? "").trim().slice(0, 40)}"`;
  const visited = el.hasAttribute("data-focus-visited");
  el.setAttribute("data-focus-visited", "");
  return { name, style: drawn.outlineStyle, width: parseFloat(drawn.outlineWidth), colour: drawn.outlineColor, highlight, visited, masthead: !!el.closest(".masthead") };
}
