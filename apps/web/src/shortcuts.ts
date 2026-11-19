import { useCallback, useEffect } from "react";
import { modalOpen } from "./components/dialog.ts";
import { decisionKeysOn } from "./decision-keys.ts";
import { navigate } from "./components/ui.tsx";
import { SCREENS } from "./routes.ts";
import { browserPlatform, isSearchChord, SEARCH_SLASH, searchKeyLabel } from "./search-keys.ts";

/**
 * The Dashboard's keyboard shortcuts: one keymap the shell listens with and the shortcut sheet lists.
 * Row movement works on whichever screen lists rows (`useRowKeys`, or `useMoveKeys` for a list that only moves and
 * opens: Approvals, Jobs, Connections and the Brain's notes); the Inbox's decision keys only once the
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
      { keys: [searchKeyLabel(browserPlatform())], does: "Search the Brain or go to a screen or setting, even from a text field" },
      { keys: [SEARCH_SLASH], does: "Search the Brain or go to a screen or setting" },
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

/** The row an opener belongs to: its list item, or the opener itself when it is the row. */
const rowOf = (opener: HTMLElement): HTMLElement => opener.closest<HTMLElement>("li") ?? opener;

/**
 * `j`/`k` on a list: the keyboard goes to the next or previous row's opener (each row's toggle, link or button, in
 * reading order; hidden ones skipped) from the row it is in, and from anywhere else to the first. The opener is a
 * button or a link, so Enter opens the row. False when there are no rows.
 */
export function moveAmongRows(openers: readonly HTMLElement[], key: "next" | "previous", active: Element | null = document.activeElement): boolean {
  const shown = openers.filter((o) => o.getClientRects().length > 0);
  if (!shown.length) return false;
  const at = active ? shown.findIndex((o) => rowOf(o).contains(active)) : -1;
  const next = shown[at < 0 ? 0 : Math.min(shown.length - 1, Math.max(0, at + (key === "next" ? 1 : -1)))]!;
  next.focus();
  next.scrollIntoView({ block: "nearest" });
  return true;
}

/** Lets `j`/`k` move between the rows whose openers match `selector` while this screen is mounted (`moveAmongRows`). */
export function useMoveKeys(selector: string): void {
  const handler = useCallback((key: RowKey) => (key === "next" || key === "previous") && moveAmongRows([...document.querySelectorAll<HTMLElement>(selector)], key), [selector]);
  useRowKeys(handler);
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
      } else {
        const key = rowKeyOf(e.key, decisionKeysOn());
        if (key && rowKeys?.(key)) e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openSheet, search]);
}
