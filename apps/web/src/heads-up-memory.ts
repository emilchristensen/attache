import { useCallback, useSyncExternalStore } from "react";

/**
 * What the owner settled in For you now (Got it, Not now), per occurrence key, in this browser only: it is not stored
 * in the service and does not replicate (the proactive roadmap moves it there). Keys are occurrences such as
 * `briefing:<id>`, never clock times, so a settled Heads-up stays settled after a time zone change.
 */
const STORAGE_KEY = "attache.heads-ups.settled";
/** Occurrences are forgotten after a week; none of today's kinds can apply again by then. */
const FORGET_AFTER_MS = 7 * 24 * 3_600_000;

type Store = Record<string, number>;

const listeners = new Set<() => void>();
let cache: { raw: string | null; keys: ReadonlySet<string> } = { raw: null, keys: new Set() };

function readRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage blocked (private window, site data off): nothing is remembered, and every Heads-up shows until it leaves.
    return null;
  }
}

function parse(raw: string | null): Store {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((e): e is [string, number] => typeof e[1] === "number"));
  } catch {
    // A value another version wrote or a hand edit: start again rather than fail the page.
    return {};
  }
}

function snapshot(): ReadonlySet<string> {
  const raw = readRaw();
  if (raw !== cache.raw) cache = { raw, keys: new Set(Object.keys(parse(raw))) };
  return cache.keys;
}

function notify() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab's Got it counts here too.
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

/** Remember one occurrence as settled, dropping ones older than a week. */
export function settleHeadsUp(key: string, now = Date.now()): void {
  const kept = Object.fromEntries(Object.entries(parse(readRaw())).filter(([, at]) => now - at < FORGET_AFTER_MS));
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...kept, [key]: now }));
  } catch {
    // Storage blocked or full: Got it still applies for this page, through the fallback below.
    cache = { raw: cache.raw, keys: new Set([...cache.keys, key]) };
  }
  notify();
}

/** The settled occurrence keys, and a way to settle one. */
export function useSettledHeadsUps(): { settled: ReadonlySet<string>; settle: (key: string) => void } {
  const settled = useSyncExternalStore(subscribe, snapshot);
  const settle = useCallback((key: string) => settleHeadsUp(key), []);
  return { settled, settle };
}
