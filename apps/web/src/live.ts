import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { API_PREFIX } from "./api.ts";
import { api, type ApiError } from "./api.ts";

export type LiveEvent = { type: string; [k: string]: unknown };
type Listener = (ev: LiveEvent) => void;

/**
 * One EventSource per tab. The service sends ordered job events with ids, so a
 * reconnect (EventSource sends Last-Event-ID automatically) replays anything
 * missed. After a reconnect every subscribed view refetches its data.
 */
class LiveHub {
  private es: EventSource | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<() => void>();
  /**
   * `connecting` only for the first attempt after the page loads; `reconnecting` once an attempt failed and the
   * browser retries, `closed` while the hub waits to start a new stream.
   */
  status: "connecting" | "open" | "reconnecting" | "closed" = "connecting";
  private opened = false;

  start() {
    if (this.es) return;
    this.es = new EventSource(`${API_PREFIX}/events`);
    this.es.onopen = () => {
      const reconnect = this.opened;
      this.opened = true;
      this.setStatus("open");
      if (reconnect) this.emit({ type: "reconnected" });
    };
    this.es.onerror = () => this.setStatus(this.es?.readyState === EventSource.CLOSED ? "closed" : "reconnecting");
    this.es.onmessage = (m) => {
      try {
        this.emit(JSON.parse(m.data) as LiveEvent);
      } catch {
        // ignore malformed frames
      }
    };
  }

  private setStatus(s: LiveHub["status"]) {
    if (this.status === s) return;
    this.status = s;
    for (const l of this.statusListeners) l();
    if (s === "closed") {
      this.es?.close();
      this.es = null;
      setTimeout(() => this.start(), 3000);
    }
  }

  private emit(ev: LiveEvent) {
    for (const l of this.listeners) l(ev);
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  onStatus(l: () => void) {
    this.statusListeners.add(l);
    return () => {
      this.statusListeners.delete(l);
    };
  }
}

export const hub = new LiveHub();

export function useLiveStatus() {
  return useSyncExternalStore(
    (cb) => hub.onStatus(cb),
    () => hub.status,
  );
}

/** The live connection as the owner hears of it: `lost` once an attempt failed; the first connect after the page loads is not news. */
export function useLiveConnection(): { status: LiveHub["status"]; lost: boolean } {
  const status = useLiveStatus();
  return { status, lost: status === "reconnecting" || status === "closed" };
}

export function useLiveEvent(handler: Listener) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => hub.on((ev) => ref.current(ev)), []);
}

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
  setData: (d: T) => void;
  /** When the request behind `data` was asked (`performance.now()`), so a newer answer can be told from an older one. */
  askedAt: number | null;
}

/**
 * Fetch a resource and refetch when a matching live event arrives or the
 * stream reconnects. Loading, error and data are kept separately so views can
 * render honest states.
 */
export function useResource<T>(path: string | null, refreshOn: string[] = []): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [askedAt, setAskedAt] = useState<number | null>(null);
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!path) return;
    const mine = ++seq.current;
    const asked = performance.now();
    setLoading(true);
    api<T>(path)
      .then((d) => {
        if (mine !== seq.current) return;
        setData(d);
        setAskedAt(asked);
        setError(null);
      })
      .catch((e: ApiError) => {
        if (mine !== seq.current) return;
        setError(e);
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, [path]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  const timer = useRef<number | null>(null);
  useLiveEvent((ev) => {
    if (ev.type === "reconnected" || refreshOn.includes(ev.type) || (ev.type === "job.event" && refreshOn.includes("job"))) {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(load, 120);
    }
  });
  return { data, error, loading, reload: load, setData, askedAt };
}
