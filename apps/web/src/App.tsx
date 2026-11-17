import { useEffect, useState, type ReactNode } from "react";
import { api, post, type ApiError } from "./api.ts";
import { hub, useLiveStatus, useResource } from "./live.ts";
import { ErrorBoundary, Link, Loading, navigate, useLocation, ErrorState } from "./components/ui.tsx";
import { EvidenceProvider } from "./components/Evidence.tsx";
import { Setup } from "./views/Setup.tsx";
import { Home } from "./views/Home.tsx";
import { MemoryView } from "./views/Memory.tsx";
import { DraftsView } from "./views/Drafts.tsx";
import { JobsView } from "./views/Jobs.tsx";
import { ConnectionsView } from "./views/Connections.tsx";
import { SettingsView } from "./views/Settings.tsx";

interface Session {
  client: { id: string; name: string; kind: string };
  version: string;
}

export const NAV: Array<{ to: string; label: string; key: string }> = [
  { to: "/", label: "Home", key: "h" },
  { to: "/memory", label: "Memory", key: "m" },
  { to: "/drafts", label: "Drafts", key: "d" },
  { to: "/jobs", label: "Jobs", key: "j" },
  { to: "/connections", label: "Connections", key: "c" },
  { to: "/settings", label: "Settings", key: "s" },
];

function Pair({ onPaired }: { onPaired: () => void }) {
  const loc = useLocation();
  const fromHash = new URLSearchParams(loc.hash.replace(/^#/, "")).get("code");
  const [code, setCode] = useState(fromHash ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (c: string) => {
    setBusy(true);
    setError(null);
    try {
      await post("/pair", { code: c, clientName: `Browser (${navigator.platform || "web"})`, kind: "browser" });
      history.replaceState(null, "", "/");
      onPaired();
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (fromHash) void submit(fromHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div className="setup" style={{ maxWidth: 520 }}>
      <div className="brand" style={{ padding: 0 }}>
        <span className="orb" aria-hidden /> Attache
      </div>
      <div className="card stack" style={{ marginTop: 24 }}>
        <h1>Pair this browser</h1>
        <p className="muted">Attache runs on this computer and only talks to paired clients. The installer opens this page with a code. To pair again, run <code>attache pair --open</code> in a terminal, or create a code in Settings on an already paired browser.</p>
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(code);
          }}
        >
          <label className="field">
            Pairing code
            <input autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCD2345" autoComplete="one-time-code" spellCheck={false} />
          </label>
          {error && (
            <p className="error-text small" role="alert">
              {error}
            </p>
          )}
          <div>
            <button className="primary" disabled={busy || code.trim().length < 6}>
              {busy ? "Pairing…" : "Pair"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Shell({ children, path }: { children: ReactNode; path: string }) {
  const live = useLiveStatus();
  const counts = useResource<{ items: unknown[] }>("/attention", ["attention.changed", "briefing.created"]);
  const drafts = useResource<Array<{ status: string }>>("/actions?status=draft,approved", ["actions.changed"]);
  const active = (to: string) => (to === "/" ? path === "/" : path.startsWith(to));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable;
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "g") {
        const next = (ev: KeyboardEvent) => {
          const n = NAV.find((x) => x.key === ev.key);
          if (n) navigate(n.to);
          window.removeEventListener("keydown", next, true);
        };
        window.addEventListener("keydown", next, true);
        setTimeout(() => window.removeEventListener("keydown", next, true), 1200);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const badge = (to: string) => (to === "/" ? (counts.data?.items.length ?? null) : to === "/drafts" ? (drafts.data?.length ?? null) : null);
  return (
    <div className="shell">
      <nav className="nav" aria-label="Main">
        <div className="brand">
          <span className="orb" aria-hidden /> Attache
        </div>
        {NAV.map((n) => (
          <Link key={n.to} to={n.to} aria-current={active(n.to) ? "page" : undefined} title={`g then ${n.key}`}>
            {n.label}
            {badge(n.to) ? <span className="count">{badge(n.to)}</span> : null}
          </Link>
        ))}
        <div className="spacer" />
        <div className="kbd-hint">
          <kbd>g</kbd> then a letter to jump
        </div>
      </nav>
      <div className="main">
        {live !== "open" && (
          <div className={`banner ${live === "closed" ? "danger" : "warn"}`} role="status">
            {live === "connecting" ? "Reconnecting to the Attache service… Work in progress continues in the service." : "Disconnected from the Attache service. Retrying."}
          </div>
        )}
        <ErrorBoundary>{children}</ErrorBoundary>
      </div>
      <nav className="bottom-nav" aria-label="Main">
        {NAV.map((n) => (
          <Link key={n.to} to={n.to} aria-current={active(n.to) ? "page" : undefined} title={n.label}>
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

export function App() {
  const loc = useLocation();
  const [session, setSession] = useState<Session | null>(null);
  const [state, setState] = useState<"checking" | "unpaired" | "ready" | "offline">("checking");
  const [err, setErr] = useState<ApiError | null>(null);
  const cfg = useResource<{ config: { setupCompleted: boolean } }>(state === "ready" ? "/config" : null, ["config.changed"]);

  const check = () => {
    setState("checking");
    api<Session>("/session")
      .then((s) => {
        setSession(s);
        setState("ready");
        hub.start();
      })
      .catch((e: ApiError) => {
        setErr(e);
        setState(e.status === 401 ? "unpaired" : "offline");
      });
  };
  useEffect(check, []);

  if (state === "checking") return <div className="setup"><Loading lines={4} label="Connecting to Attache" /></div>;
  if (state === "offline") return <div className="setup"><ErrorState error={err} retry={check} title="Attache service is not reachable" /><p className="muted small" style={{ marginTop: 12 }}>The service normally starts at login. Run <code>attache status</code> or reinstall to repair it.</p></div>;
  if (state === "unpaired" || loc.path === "/pair") return <Pair onPaired={check} />;
  if (!session || !cfg.data) return <div className="setup"><Loading lines={4} /></div>;
  if (!cfg.data.config.setupCompleted || loc.path === "/setup") return <EvidenceProvider><Setup onDone={() => { cfg.reload(); navigate("/"); }} /></EvidenceProvider>;

  const p = loc.path;
  const view = p === "/" ? <Home /> : p.startsWith("/memory") ? <MemoryView /> : p.startsWith("/drafts") ? <DraftsView /> : p.startsWith("/jobs") ? <JobsView /> : p.startsWith("/connections") ? <ConnectionsView /> : p.startsWith("/settings") ? <SettingsView /> : <div className="page"><h1>Not found</h1><p><Link to="/">Go home</Link></p></div>;
  return (
    <EvidenceProvider>
      <Shell path={p}>{view}</Shell>
    </EvidenceProvider>
  );
}
