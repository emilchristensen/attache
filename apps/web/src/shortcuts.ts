import { useEffect } from "react";
import { modalOpen } from "./components/dialog.ts";
import { decisionKeysOn } from "./decision-keys.ts";
import { navigate } from "./components/ui.tsx";
import { SCREENS } from "./routes.ts";
import { browserPlatform, isSearchChord, SEARCH_SLASH, searchKeyLabel } from "./search-keys.ts";
import { launchSearch } from "./search-launch.ts";

/**
 * The Dashboard's keyboard shortcuts: one keymap the shell listens with and the shortcut sheet lists.
 * Row movement works on whichever screen lists rows (`useRowKeys`); the Inbox's decision keys only once the
 * owner switches them on in the sheet (`decision-keys.ts`). There is never a single key for Apply, Reject, Approve,
 * Send, Revert or Disconnect.
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
  /** The group is off until switched on in the sheet: the Inbox's decision keys. */
  switchable?: true;
}

/** What a row key asks the listed rows to do. Moving changes nothing; a decision has Undo in its row. */
export type RowKey = "next" | "previous" | "done" | "snooze" | "dismiss";

/** Keys that move between rows and open one; they change nothing. */
export const MOVE_KEYS: Readonly<Record<string, RowKey>> = { j: "next", k: "previous" };
/** The Inbox's decision keys, off until switched on. */
export const DECISION_KEYS: Readonly<Record<string, RowKey>> = { d: "done", s: "snooze", x: "dismiss" };

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  { title: "Go to", rows: SCREENS.map((s) => ({ keys: [JUMP_KEY, s.key], does: s.label })) },
  {
    title: "Search",
    rows: [
      { keys: [searchKeyLabel(browserPlatform())], does: "Search the Brain, even from a text field" },
      { keys: [SEARCH_SLASH], does: "Search the Brain" },
    ],
  },
  {
    title: "Rows",
    rows: [
      { keys: ["j"], does: "Next row" },
      { keys: ["k"], does: "Previous row" },
      { keys: ["Enter"], does: "Open or close the row" },
    ],
  },
  {
    title: "Inbox decisions",
    switchable: true,
    rows: [
      { keys: ["d"], does: "Done" },
      { keys: ["s"], does: "Snooze until tomorrow 09:00" },
      { keys: ["x"], does: "Dismiss" },
    ],
  },
  { title: "Help", rows: [{ keys: [SHEET_KEY], does: "Show this list of shortcuts" }] },
];

/** Where `g` then `key` jumps, or null. */
export function jumpTarget(key: string): string | null {
  return SCREENS.find((s) => s.key === key)?.to ?? null;
}

/** The row key `key` stands for now, or null: a decision key only while the decision keys are on. */
export function rowKeyOf(key: string, decisionsOn: boolean): RowKey | null {
  return MOVE_KEYS[key] ?? (decisionsOn ? (DECISION_KEYS[key] ?? null) : null);
}

/** Answers row keys; true when it used the key. One screen at a time lists rows. */
export type RowKeyHandler = (key: RowKey) => boolean;
let rowKeys: RowKeyHandler | null = null;

/** Lets the shell's keymap pass row keys to this screen's rows while it is mounted. */
export function useRowKeys(handler: RowKeyHandler): void {
  useEffect(() => {
    rowKeys = handler;
    return () => {
      if (rowKeys === handler) rowKeys = null;
    };
  }, [handler]);
}

/** The owner is typing, composing text, holding a modifier, or inside a modal: shortcuts stay out of the way. */
export function shortcutsIgnore(e: KeyboardEvent): boolean {
  if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return true;
  const t = e.target instanceof HTMLElement ? e.target : null;
  if (t && (t.isContentEditable || t.closest("input, textarea, select, [contenteditable='true']"))) return true;
  return modalOpen();
}

/** Listens for the jumps and `?` while the shell is mounted. */
export function useShortcuts(openSheet: () => void): void {
  useEffect(() => {
    let jumpUntil = 0;
    const onKey = (e: KeyboardEvent) => {
      // Ctrl K and Cmd K search from anywhere, a text field included, but never from inside a dialog.
      if (!e.defaultPrevented && !e.isComposing && isSearchChord(e) && !modalOpen()) {
        e.preventDefault();
        jumpUntil = 0;
        launchSearch();
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
        launchSearch();
      } else {
        const key = rowKeyOf(e.key, decisionKeysOn());
        if (key && rowKeys?.(key)) e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSheet]);
}
