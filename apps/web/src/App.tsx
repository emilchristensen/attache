import { useEffect, useState, type ReactNode } from "react";
import { api, type ApiError } from "./api.ts";
import { hub, useResource } from "./live.ts";
import { Link, Loading, navigate, useLocation } from "./components/ui.tsx";
import { EvidenceProvider } from "./components/Evidence.tsx";
import { CompactScreen } from "./components/CompactScreen.tsx";
import { Shell } from "./components/Shell.tsx";
import { screenAt, type ScreenId } from "./routes.ts";
import { Pair } from "./views/Pair.tsx";
import { ServiceUnreachable } from "./views/ServiceUnreachable.tsx";
import { Setup } from "./views/Setup.tsx";
import { Home } from "./views/Home.tsx";
import { BriefingPage } from "./views/BriefingPage.tsx";
import { ApprovalsView } from "./views/Approvals.tsx";
import { BrainView } from "./views/Brain.tsx";
import { JobsView } from "./views/Jobs.tsx";
import { ConnectionsView } from "./views/Connections.tsx";
import { SettingsView } from "./views/Settings.tsx";

interface Session {
  client: { id: string; name: string; kind: string };
  version: string;
}

/** Each screen's view; the shell around it comes from `components/Shell.tsx`. */
const VIEWS: Record<ScreenId, () => ReactNode> = {
  home: () => <Home />,
  briefing: () => <BriefingPage />,
  approvals: () => <ApprovalsView />,
  brain: () => <BrainView />,
  connections: () => <ConnectionsView />,
  jobs: () => <JobsView />,
  settings: () => <SettingsView />,
};

function NotFound() {
  return (
    <div className="page">
      <h1>Not found</h1>
      <p>
        <Link to="/">Go home</Link>
      </p>
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

  const id = screenAt(loc.path);
  return (
    <EvidenceProvider>
      <Shell path={loc.path}>{id ? VIEWS[id]() : <NotFound />}</Shell>
    </EvidenceProvider>
  );
}
