import { useCallback, useSyncExternalStore } from "react";

/**
 * Whether the Inbox's decision keys (Done, Snooze, Dismiss) are on in this browser. They are off until the owner
 * switches them on in the shortcut sheet, so a stray key never changes the Inbox. Kept in localStorage; storage
 * that is blocked falls back to this page's memory, and another tab's switch applies here too.
 */

const STORAGE_KEY = "attache.decision-keys";
const listeners = new Set<() => void>();
let fallback = false;

function read(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return fallback;
  }
}

function write(on: boolean): void {
  fallback = on;
  try {
    if (on) window.localStorage.setItem(STORAGE_KEY, "on");
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Blocked storage: the switch lasts until the page closes.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const fromOtherTab = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY || e.key === null) listener();
  };
  window.addEventListener("storage", fromOtherTab);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", fromOtherTab);
  };
}

/** The current switch, read outside React (the keymap reads it on each key). */
export const decisionKeysOn = read;

export function useDecisionKeys(): [on: boolean, set: (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, read, () => false);
  return [on, useCallback((next: boolean) => write(next), [])];
}
