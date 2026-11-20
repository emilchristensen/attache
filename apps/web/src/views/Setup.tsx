import { useEffect, useState, type ReactNode } from "react";
import type { FeatureStatus, Config } from "@attache/contracts";
import { api, patch, post, type ApiError } from "../api.ts";
import { useResource } from "../live.ts";
import { ErrorState, Loading, useAction, useLocation } from "../components/ui.tsx";
import { StateTag } from "../components/StateTag.tsx";
import { ConnectionCard } from "../components/ConnectionCard.tsx";
import { Logo } from "../components/Logo.tsx";
import { Icon } from "../components/icons.tsx";
import { SetupActions } from "./SetupActions.tsx";
import { DataFolderStep } from "./SetupDataFolder.tsx";
import { FeatureList, type Caps } from "./FeatureList.tsx";

const STEPS = ["Data folder", "Features", "Connections", "Model and schedules", "Test and finish"];


export function Setup({ onDone }: { onDone: () => void }) {
  const cfg = useResource<{ config: Config }>("/config", ["config.changed"]);
  const [step, setStep] = useState<number | null>(null);
  useEffect(() => {
    if (cfg.data && step === null) setStep(Math.min(cfg.data.config.setupStep ?? 0, STEPS.length - 1));
  }, [cfg.data, step]);
  const go = (n: number) => {
    setStep(n);
    void patch("/config", { setupStep: n }).catch(() => {});
    window.scrollTo(0, 0);
  };
  if (!cfg.data || step === null)
    return (
      <main className="setup" aria-busy>
        <SetupAside />
        <div className="setup-form">
          <Loading />
        </div>
      </main>
    );
  const hasFolder = !!cfg.data.config.dataFolder;
  return (
    <main className="setup">
      <SetupAside>
        <nav aria-label="Setup progress">
          <ol className="setup-steps">
            {STEPS.map((s, i) => (
              <li key={s}>
                <button type="button" aria-current={i === step ? "step" : undefined} className={i < step ? "done" : undefined} disabled={i > 0 && !hasFolder} onClick={() => go(i)}>
                  <span className="setup-step-mark" aria-hidden>
                    {i < step ? <Icon name="check" size={14} /> : i + 1}
                  </span>
                  <span className="setup-step-label">{s}</span>
                  {i < step && <span className="sr-only">, done</span>}
                </button>
              </li>
            ))}
          </ol>
        </nav>
      </SetupAside>
      <div className="setup-form">
        {step === 0 && <DataFolderStep config={cfg.data.config} onNext={() => { cfg.reload(); go(1); }} />}
        {step === 1 && <FeaturesStep onBack={() => go(0)} onNext={() => go(2)} />}
        {step === 2 && <ConnectionsStep onBack={() => go(1)} onNext={() => go(3)} />}
        {step === 3 && <ModelStep config={cfg.data.config} onBack={() => go(2)} onNext={() => go(4)} />}
        {step === 4 && <FinishStep onBack={() => go(3)} onDone={onDone} />}
      </div>
    </main>
  );
}

/** Setup's left pane: the large logo, without its dot since nothing waits yet, then the steps. */
function SetupAside({ children }: { children?: ReactNode }) {
  return (
    <aside className="setup-aside">
      <div className="setup-brand">
        <Logo size={64} attention={false} />
        <span>
          Attache <span className="setup-brand-sub">setup</span>
        </span>
      </div>
      {children}
    </aside>
  );
}

function Nav({ onBack, onNext, nextLabel = "Continue", disabled }: { onBack?: () => void; onNext: () => void; nextLabel?: string; disabled?: boolean }) {
  return (
    <SetupActions>
      {onBack && (
        <button className="ghost" onClick={onBack}>
          Back
        </button>
      )}
      <div style={{ flex: 1 }} />
      <button className="primary" onClick={onNext} disabled={disabled}>
        {nextLabel}
      </button>
    </SetupActions>
  );
}

function FeaturesStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const caps = useResource<Caps>("/capabilities", ["config.changed", "connections.changed"]);
  return (
    <section className="stack">
      <h1>Choose what Attache does</h1>
      <p className="muted">Search is the core and works with just your notes. Everything else is optional, and you can change it later in Settings.</p>
      {caps.loading && !caps.data && <Loading />}
      <ErrorState error={caps.error} retry={caps.reload} />
      {caps.data && <FeatureList caps={caps.data} onChanged={caps.reload} />}
      <Nav onBack={onBack} onNext={onNext} />
    </section>
  );
}

const SOURCE_KINDS = ["github", "jira", "confluence", "slack", "gmail", "gcal"];
const HARNESS_KINDS = ["claude-code", "codex", "antigravity", "claude-desktop", "pi", "opencode"];

function ConnectionsStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const caps = useResource<Caps>("/capabilities", ["connections.changed"]);
  const loc = useLocation();
  const oauth = loc.search.get("oauth");
  return (
    <section className="stack">
      <h1>Connect sources (optional)</h1>
      <p className="muted">Connect only what you want Attache to watch. Every connection starts read-only; writing is authorised separately, per action. You can skip this and connect later.</p>
      {oauth && <div className={`state ${oauth === "ok" ? "partial" : "error"} small`}>{loc.search.get("message")}</div>}
      {caps.loading && !caps.data && <Loading />}
      <ErrorState error={caps.error} retry={caps.reload} />
      {caps.data && SOURCE_KINDS.map((k) => <SetupCard key={k} kind={k} caps={caps.data!} onChanged={caps.reload} />)}
      <h2>Harnesses</h2>
      <p className="muted">Connect the Harnesses you use. Each gets Attache's MCP server, so it can search, read and save to your Brain without asking; you can switch that off per Harness in Settings. Claude Code, Codex and Antigravity also get hooks that save each session with a short summary of what was decided and give every new session your memory. Pi gets one Attache extension that registers the MCP server in each Pi session, and OpenCode one Attache plugin that does the same each time OpenCode loads it. Only Attache's own entries are added to each configuration file, the file is backed up first, and everything else in it is left as it is.</p>
      {caps.data && HARNESS_KINDS.map((k) => <SetupCard key={k} kind={k} caps={caps.data!} onChanged={caps.reload} />)}
      <Nav onBack={onBack} onNext={onNext} nextLabel="Continue" />
    </section>
  );
}

function SetupCard({ kind, caps, onChanged }: { kind: string; caps: Caps; onChanged: () => void }) {
  const st = caps.connections.find((c) => c.kind === kind);
  const def = caps.definitions.find((d) => d.kind === kind);
  return st && def ? <ConnectionCard status={st} definition={def} onChanged={onChanged} compact /> : null;
}

function ModelStep({ config, onBack, onNext }: { config: Config; onBack: () => void; onNext: () => void }) {
  const caps = useResource<Caps>("/capabilities", ["connections.changed", "config.changed"]);
  const [sched, setSched] = useState(config.schedules);
  const [notify, setNotify] = useState(config.notifications.desktop);
  const { run } = useAction();
  const attentionOn = caps.data?.features.find((f) => f.id === "attention")?.enabled;
  const card = (k: string) => {
    const st = caps.data?.connections.find((c) => c.kind === k);
    const def = caps.data?.definitions.find((d) => d.kind === k);
    return st && def ? <ConnectionCard status={st} definition={def} onChanged={caps.reload} compact /> : null;
  };
  const writable = caps.data?.connections.filter((c) => c.status === "connected" && c.availableWriteActions.length) ?? [];
  const save = () => run("save", async () => { await patch("/config", { schedules: sched, notifications: { desktop: notify } }); onNext(); });
  return (
    <section className="stack">
      <h1>Model and schedules</h1>
      <h2>Model</h2>
      <p className="muted small">Optional. Without a model, Attache still searches and shows the evidence it finds.</p>
      {card("model")}
      {attentionOn && (
        <>
          <h2>Schedules</h2>
          <div className="card grid-2">
            <label className="field">
              Refresh sources every (minutes)
              <input type="number" min={5} max={1440} value={sched.refreshEveryMinutes} onChange={(e) => setSched({ ...sched, refreshEveryMinutes: Math.min(1440, Math.max(5, Math.round(Number(e.target.value)) || 30)) })} />
            </label>
            <label className="field">
              Daily briefing at
              <input type="time" value={sched.briefingAt} onChange={(e) => setSched({ ...sched, briefingAt: e.target.value })} disabled={!sched.briefingEnabled} />
            </label>
            <label className="check small">
              <input type="checkbox" checked={sched.briefingEnabled} onChange={(e) => setSched({ ...sched, briefingEnabled: e.target.checked })} /> Prepare a daily briefing
            </label>
            <label className="check small">
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Show a desktop notification for new urgent items
            </label>
          </div>
          <p className="small muted">Schedules run in the Attache service, not the browser. If this Machine sleeps, missed runs are caught up once when it wakes.</p>
        </>
      )}
      <h2>Action permissions</h2>
      <p className="small muted">
        {writable.length ? `Write permissions can be granted per action on ${writable.map((w) => w.label).join(", ")} in Connections. ` : "No connected source can write yet. "}
        Everything starts read-only, and each action still needs your approval of its exact text.
      </p>
      <Nav onBack={onBack} onNext={save} />
    </section>
  );
}

function FinishStep({ onBack, onDone }: { onBack: () => void; onDone: () => void }) {
  const [result, setResult] = useState<{ connections: Array<{ id: string; label: string; kind: string; ok: boolean; state: string; message: string }>; features: FeatureStatus[] } | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [testing, setTesting] = useState(false);
  const { busy, run } = useAction();
  const test = async () => {
    setTesting(true);
    setErr(null);
    try {
      setResult(await post("/setup/test"));
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setTesting(false);
    }
  };
  useEffect(() => {
    void test();
  }, []);
  return (
    <section className="stack">
      <h1>Check and finish</h1>
      <p className="muted">Attache tests each connection you set up. Anything not ready stays visible in Settings; you can finish now and fix it later.</p>
      {testing && <Loading lines={5} label="Testing configuration" />}
      <ErrorState error={err} retry={test} />
      {result && (
        <>
          <div className="card">
            <h3>Features</h3>
            <div className="check-list">
              {result.features.filter((f) => f.enabled).map((f) => (
                <div key={f.id} className="check-row" data-feature-status={f.id}>
                  <span>{f.label}</span>
                  <StateTag state={f.readiness} label={f.readiness.replace(/_/g, " ")} />
                  {f.reason && <span className="small muted">{f.reason}</span>}
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <h3>Connections</h3>
            {result.connections.length === 0 ? (
              <p className="small muted">No connections. Attache will work as a notes-only workspace.</p>
            ) : (
              <div className="check-list">
                {result.connections.map((c) => (
                  <div key={c.id} className="check-row">
                    <span>{c.label}</span>
                    <StateTag state={c.ok ? "ready" : c.state} label={c.ok ? "ready" : c.state.replace(/_/g, " ")} />
                    {c.message && <span className="small muted">{c.message}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
      <SetupActions>
        <button className="ghost" onClick={onBack}>
          Back
        </button>
        <button onClick={test} disabled={testing}>
          Test again
        </button>
        <div style={{ flex: 1 }} />
        <button className="primary" disabled={busy !== null || testing} onClick={() => run("finish", async () => { await post("/setup/complete"); await api("/config"); onDone(); })}>
          Finish setup
        </button>
      </SetupActions>
    </section>
  );
}
