import { Component, createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import MarkdownIt from "markdown-it";
import type { ApiError } from "../api.ts";

// ---- routing -------------------------------------------------------------------

const routeListeners = new Set<() => void>();
window.addEventListener("popstate", () => routeListeners.forEach((l) => l()));

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  routeListeners.forEach((l) => l());
}

export function useLocation(): { path: string; search: URLSearchParams; hash: string } {
  const href = useSyncExternalStore(
    (cb) => {
      routeListeners.add(cb);
      return () => routeListeners.delete(cb);
    },
    () => location.pathname + location.search + location.hash,
  );
  return useMemo(() => {
    const u = new URL(href, location.origin);
    return { path: u.pathname, search: u.searchParams, hash: u.hash };
  }, [href]);
}

export function Link(props: { to: string; children: ReactNode; className?: string; "aria-current"?: "page" | undefined; title?: string }) {
  return (
    <a
      href={props.to}
      className={props.className}
      aria-current={props["aria-current"]}
      title={props.title}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(props.to);
      }}
    >
      {props.children}
    </a>
  );
}

// ---- states ---------------------------------------------------------------------

export function Loading({ lines = 3, label = "Loading" }: { lines?: number; label?: string }) {
  return (
    <div className="stack-sm" role="status" aria-label={label}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${90 - i * 15}%` }} />
      ))}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      <strong style={{ color: "var(--text-2)" }}>{title}</strong>
      {children && <div className="small">{children}</div>}
      {action}
    </div>
  );
}

export function ErrorState({ error, retry, title }: { error: ApiError | Error | null; retry?: () => void; title?: string }) {
  if (!error) return null;
  const offline = (error as ApiError).code === "offline";
  const disabled = (error as ApiError).code === "feature_disabled";
  return (
    <div className="state error" role="alert">
      <strong>{title ?? (offline ? "Jarvis is not reachable" : disabled ? "This feature is turned off" : "Something went wrong")}</strong>
      <span className="small">{error.message}</span>
      <div className="row">
        {retry && <button onClick={retry}>Try again</button>}
        {disabled && <Link to="/settings">Open Settings</Link>}
      </div>
    </div>
  );
}

export function StatusPill({ state, label }: { state: string; label?: string }) {
  const cls = ["ready", "connected", "complete", "empty", "succeeded", "ok", "applied", "open"].includes(state)
    ? "ok"
    : ["partial", "needs_setup", "needs_auth", "queued", "running", "draft", "approved", "snoozed", "proposed", "executing", "blocked", "revoked", "unknown", "never_run"].includes(state)
      ? "warn"
      : ["error", "failed", "unavailable", "denied", "unauthorized", "offline", "expired", "rejected"].includes(state)
        ? "danger"
        : "";
  return (
    <span className={`pill ${cls}`}>
      <span className="dot" aria-hidden />
      {label ?? state.replace(/_/g, " ")}
    </span>
  );
}

// ---- time --------------------------------------------------------------------------

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return iso;
  const s = Math.round((Date.now() - d) / 1000);
  const abs = Math.abs(s);
  const fmt = (n: number, u: string) => `${n} ${u}${n === 1 ? "" : "s"}`;
  const v = abs < 60 ? fmt(abs, "second") : abs < 3600 ? fmt(Math.round(abs / 60), "minute") : abs < 86400 ? fmt(Math.round(abs / 3600), "hour") : fmt(Math.round(abs / 86400), "day");
  if (abs < 10) return "just now";
  return s >= 0 ? `${v} ago` : `in ${v}`;
}

export function useNow(intervalMs = 30_000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
}

export function Time({ iso }: { iso: string | null | undefined }) {
  useNow();
  return <time dateTime={iso ?? undefined} title={iso ? new Date(iso).toLocaleString() : undefined}>{relTime(iso)}</time>;
}

// ---- markdown (safe: raw HTML disabled; markdown-it rejects javascript: links) ---------

const md = new MarkdownIt({ html: false, linkify: true, breaks: false, typographer: false });
const defaultLink = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx]!.attrSet("target", "_blank");
  tokens[idx]!.attrSet("rel", "noopener noreferrer");
  return defaultLink(tokens, idx, options, env, self);
};

export function renderMarkdown(text: string): string {
  return md.render(text);
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => md.render(text), [text]);
  return <div className={`md ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---- toasts ---------------------------------------------------------------------------

interface Toast {
  id: number;
  text: string;
  kind: "ok" | "error" | "info";
}
const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 9000 : 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span>{t.text}</span>
            <button className="ghost small" aria-label="Dismiss notification" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** Run an async action with a busy flag and error toast. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(key: string, fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
      setBusy(key);
      try {
        const r = await fn();
        if (ok) toast(ok, "ok");
        return r;
      } catch (e) {
        toast((e as Error).message, "error");
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );
  return { busy, run };
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error)
      return (
        <div className="page">
          <ErrorState error={this.state.error} title="This view crashed" retry={() => this.setState({ error: null })} />
        </div>
      );
    return this.props.children;
  }
}
