/**
 * The keys that search the Brain: `Ctrl K` or `Cmd K` anywhere, even inside a text field, and `/` outside one.
 * Pure, so the rules are unit-tested; `shortcuts.ts` listens for them.
 */

export const SEARCH_SLASH = "/";

interface Chord {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** `Ctrl K` or `Cmd K`, with no other modifier. */
export function isSearchChord(e: Chord): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
}

/** The chord as this system writes it, for the keycap in the field and the shortcut sheet. */
export function searchKeyLabel(platform: string): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘ K" : "Ctrl K";
}

/** The browser's platform: `userAgentData` where it exists, the older `navigator.platform` elsewhere. */
export function browserPlatform(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform || nav.platform || "";
}

/** A text field's selection, as `selectionStart`, `selectionEnd` and `selectionDirection` give it. */
export interface Caret {
  start: number;
  end: number;
  direction: "forward" | "backward" | "none";
}

/**
 * Where `Home` or `End` (with `Shift`, selecting) puts the caret in the search field's text of `length`, or null
 * for any other key. The field moves the caret itself because on macOS these keys scroll the page instead, which
 * would carry the field and its open results out of view; the combobox pattern keeps them in the text.
 */
export function caretAfter(e: Chord, caret: Caret, length: number): Caret | null {
  if ((e.key !== "Home" && e.key !== "End") || e.ctrlKey || e.metaKey || e.altKey) return null;
  const to = e.key === "Home" ? 0 : length;
  if (!e.shiftKey) return { start: to, end: to, direction: "none" };
  const anchor = caret.direction === "backward" ? caret.end : caret.start;
  return to < anchor ? { start: to, end: anchor, direction: "backward" } : { start: anchor, end: to, direction: "forward" };
}
