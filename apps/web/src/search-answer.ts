import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { SEARCH_DEBOUNCE_MS, searchPath, type SearchAnswer } from "./search.ts";

/**
 * The service's answer to what the owner is typing. A search is a read: it starts no job and changes nothing.
 * While a new answer is on its way, the last one stays (`previous`), so the results keep their height.
 */
export type SearchState =
  | { status: "idle" }
  | { status: "searching"; query: string; previous: SearchAnswer | null }
  | { status: "ready"; query: string; answer: SearchAnswer }
  | { status: "failed"; query: string; message: string; previous: SearchAnswer | null };

/** The answer on screen: the current one, or the last one while searching again or after a failure. */
export function shownAnswer(state: SearchState): SearchAnswer | null {
  if (state.status === "ready") return state.answer;
  if (state.status === "idle") return null;
  return state.previous;
}

export function useSearchAnswer(query: string, limit: number): { state: SearchState; retry: () => void } {
  const [state, setState] = useState<SearchState>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);
  const q = query.trim();
  useEffect(() => {
    if (!q) {
      setState({ status: "idle" });
      return;
    }
    setState((s) => ({ status: "searching", query: q, previous: shownAnswer(s) }));
    const abort = new AbortController();
    const timer = setTimeout(() => {
      api<SearchAnswer>(searchPath(q, limit), { signal: abort.signal }).then(
        (answer) => setState({ status: "ready", query: q, answer }),
        (e: unknown) => {
          // A newer query (or leaving the page) aborted this one; its own answer follows.
          if (abort.signal.aborted) return;
          const message = e instanceof Error ? e.message : String(e);
          setState((s) => ({ status: "failed", query: q, message, previous: shownAnswer(s) }));
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [q, limit, attempt]);
  return { state, retry: () => setAttempt((n) => n + 1) };
}
