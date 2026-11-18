import { useEffect, useState, type ReactNode } from "react";
import { api, type ApiError } from "./api.ts";
import { hub, useLiveStatus, useResource } from "./live.ts";
import { ErrorBoundary, Link, Loading, navigate, useLocation } from "./components/ui.tsx";
import { EvidenceProvider } from "./components/Evidence.tsx";
import { Logo } from "./components/Logo.tsx";
import { CompactScreen } from "./components/CompactScreen.tsx";
import { Pair } from "./views/Pair.tsx";
import { ServiceUnreachable } from "./views/ServiceUnreachable.tsx";
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
          <Logo attention={(counts.data?.items.length ?? 0) > 0} /> Attache
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

  if (state === "checking") return <CompactScreen busy><Loading lines={4} label="Connecting to Attache" /></CompactScreen>;
  if (state === "offline") return <ServiceUnreachable error={err} retry={check} />;
  if (state === "unpaired" || loc.path === "/pair") return <Pair onPaired={check} />;
  if (!session || !cfg.data) return <CompactScreen busy><Loading lines={4} /></CompactScreen>;
  if (!cfg.data.config.setupCompleted || loc.path === "/setup") return <EvidenceProvider><Setup onDone={() => { cfg.reload(); navigate("/"); }} /></EvidenceProvider>;

  const p = loc.path;
  const view = p === "/" ? <Home /> : p.startsWith("/memory") ? <MemoryView /> : p.startsWith("/drafts") ? <DraftsView /> : p.startsWith("/jobs") ? <JobsView /> : p.startsWith("/connections") ? <ConnectionsView /> : p.startsWith("/settings") ? <SettingsView /> : <div className="page"><h1>Not found</h1><p><Link to="/">Go home</Link></p></div>;
  return (
    <EvidenceProvider>
      <Shell path={p}>{view}</Shell>
    </EvidenceProvider>
  );
}
