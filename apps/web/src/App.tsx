import { useEffect, useState, type ReactNode } from "react";
import { api, post, type ApiError } from "./api.ts";
import { hub, useResource } from "./live.ts";
import { Link, Loading, navigate, useLocation, ErrorState } from "./components/ui.tsx";
import { EvidenceProvider } from "./components/Evidence.tsx";
import { Logo } from "./components/Logo.tsx";
import { Shell } from "./components/Shell.tsx";
import { screenAt, type ScreenId } from "./routes.ts";
import { Setup } from "./views/Setup.tsx";
import { Home } from "./views/Home.tsx";
import { ApprovalsView } from "./views/Approvals.tsx";
import { BrainView } from "./views/Brain.tsx";
import { JobsView } from "./views/Jobs.tsx";
import { ConnectionsView } from "./views/Connections.tsx";
import { SettingsView } from "./views/Settings.tsx";

interface Session {
  client: { id: string; name: string; kind: string };
  version: string;
}

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
        <Logo /> Attache
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

/** Each screen's view; the shell around it comes from `components/Shell.tsx`. */
const VIEWS: Record<ScreenId, () => ReactNode> = {
  home: () => <Home />,
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

  if (state === "checking") return <div className="setup"><Loading lines={4} label="Connecting to Attache" /></div>;
  if (state === "offline") return <div className="setup"><ErrorState error={err} retry={check} title="Attache service is not reachable" /><p className="muted small" style={{ marginTop: 12 }}>The service normally starts at login. Run <code>attache status</code> or reinstall to repair it.</p></div>;
  if (state === "unpaired" || loc.path === "/pair") return <Pair onPaired={check} />;
  if (!session || !cfg.data) return <div className="setup"><Loading lines={4} /></div>;
  if (!cfg.data.config.setupCompleted || loc.path === "/setup") return <EvidenceProvider><Setup onDone={() => { cfg.reload(); navigate("/"); }} /></EvidenceProvider>;

  const id = screenAt(loc.path);
  return (
    <EvidenceProvider>
      <Shell path={loc.path}>{id ? VIEWS[id]() : <NotFound />}</Shell>
    </EvidenceProvider>
  );
}
