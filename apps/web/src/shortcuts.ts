import { useEffect } from "react";
import { modalOpen } from "./components/dialog.ts";
import { navigate } from "./components/ui.tsx";
import { SCREENS } from "./routes.ts";
import { browserPlatform, isSearchChord, SEARCH_SLASH, searchKeyLabel } from "./search-keys.ts";

/**
 * The Dashboard's keyboard shortcuts: one keymap the shell listens with and the shortcut sheet lists.
 * Later tickets add their entries here (row movement, the opt-in decision keys); there is never
 * a single key for Apply, Reject, Approve, Send, Revert or Disconnect.
 */

/** The key that starts a jump, and how long the second key may take. */
export const JUMP_KEY = "g";
export const JUMP_WINDOW_MS = 1200;
/** The key that opens the shortcut sheet. */
export const SHEET_KEY = "?";

export interface ShortcutRow {
  /** Keys pressed one after the other. */
  keys: readonly string[];
  does: string;
}

export interface ShortcutGroup {
  title: string;
  rows: readonly ShortcutRow[];
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  { title: "Go to", rows: SCREENS.map((s) => ({ keys: [JUMP_KEY, s.key], does: s.label })) },
  {
    title: "Search",
    rows: [
      { keys: [searchKeyLabel(browserPlatform())], does: "Search the Brain or go to a screen or setting, even from a text field" },
      { keys: [SEARCH_SLASH], does: "Search the Brain or go to a screen or setting" },
    ],
  },
  { title: "Help", rows: [{ keys: [SHEET_KEY], does: "Show this list of shortcuts" }] },
];

/** Where `g` then `key` jumps, or null. */
export function jumpTarget(key: string): string | null {
  return SCREENS.find((s) => s.key === key)?.to ?? null;
}

/** The owner is typing, composing text, holding a modifier, or inside a modal: shortcuts stay out of the way. */
export function shortcutsIgnore(e: KeyboardEvent): boolean {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return true;
  const t = e.target instanceof HTMLElement ? e.target : null;
  if (t && (t.isContentEditable || t.closest("input, textarea, select, [contenteditable='true']"))) return true;
  return modalOpen();
}

/** Listens for the jumps, `?` and the search keys (`search` focuses Home's field or opens the palette) while the shell is mounted. */
export function useShortcuts(openSheet: () => void, search: () => void): void {
  useEffect(() => {
    let jumpUntil = 0;
    const onKey = (e: KeyboardEvent) => {
      // Ctrl K and Cmd K search from anywhere, a text field included, but never from inside a dialog.
      if (!e.defaultPrevented && !e.isComposing && isSearchChord(e) && !modalOpen()) {
        e.preventDefault();
        jumpUntil = 0;
        search();
        return;
      }
      if (e.defaultPrevented || shortcutsIgnore(e)) {
        jumpUntil = 0;
        return;
      }
      if (Date.now() < jumpUntil) {
        jumpUntil = 0;
        const to = jumpTarget(e.key);
        if (to) {
          e.preventDefault();
          navigate(to);
        }
        return;
      }
      if (e.key === JUMP_KEY) {
        jumpUntil = Date.now() + JUMP_WINDOW_MS;
      } else if (e.key === SHEET_KEY) {
        e.preventDefault();
        openSheet();
      } else if (e.key === SEARCH_SLASH) {
        e.preventDefault();
        search();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSheet, search]);
}
