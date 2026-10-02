import { useEffect, useState } from "react";
import type { ConnectionDefinition, ConnectionStatus, FeatureStatus, Config } from "@jarvis/contracts";
import { api, patch, post, put, type ApiError } from "../api.ts";
import { useResource } from "../live.ts";
import { ErrorState, Loading, StatusPill, useAction, useLocation } from "../components/ui.tsx";
import { ConnectionCard } from "../components/ConnectionCard.tsx";

const STEPS = ["Data folder", "Features", "Connections", "Model, voice and schedules", "Test and finish"];

interface Caps {
  features: FeatureStatus[];
  connections: ConnectionStatus[];
  definitions: ConnectionDefinition[];
}

interface Preview {
  path: string;
  exists: boolean;
  writable: boolean;
  markdownFiles: number;
  sample: string[];
  willCreate: string[];
  willModify: string[];
  note: string;
}

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
  if (!cfg.data || step === null) return <div className="setup"><Loading /></div>;
  const hasFolder = !!cfg.data.config.dataFolder;
  return (
    <main className="setup">
      <div className="brand" style={{ padding: 0 }}>
        <span className="orb" data-state="idle" aria-hidden /> Jarvis setup
      </div>
      <nav aria-label="Setup progress">
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s} aria-current={i === step ? "step" : undefined} className={i < step ? "done" : ""}>
              <button className="ghost small" style={{ padding: 0, border: "none", color: "inherit" }} disabled={i > 0 && !hasFolder} onClick={() => go(i)}>
                {i + 1}. {s}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      {step === 0 && <DataFolderStep config={cfg.data.config} onNext={() => { cfg.reload(); go(1); }} />}
      {step === 1 && <FeaturesStep onBack={() => go(0)} onNext={() => go(2)} />}
      {step === 2 && <ConnectionsStep onBack={() => go(1)} onNext={() => go(3)} />}
      {step === 3 && <ModelStep config={cfg.data.config} onBack={() => go(2)} onNext={() => go(4)} />}
      {step === 4 && <FinishStep onBack={() => go(3)} onDone={onDone} />}
    </main>
  );
}

function Nav({ onBack, onNext, nextLabel = "Continue", disabled }: { onBack?: () => void; onNext: () => void; nextLabel?: string; disabled?: boolean }) {
  return (
    <div className="row" style={{ marginTop: 20 }}>
      {onBack && (
        <button className="ghost" onClick={onBack}>
          Back
        </button>
      )}
      <div style={{ flex: 1 }} />
      <button className="primary" onClick={onNext} disabled={disabled}>
        {nextLabel}
      </button>
    </div>
  );
}

function DataFolderStep({ config, onNext }: { config: Config; onNext: () => void }) {
  const defaults = useResource<{ suggestion: string; home: string }>("/setup/defaults");
  const [path, setPath] = useState(config.dataFolder ?? "");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [name, setName] = useState(config.identity?.name ?? "");
  const [email, setEmail] = useState(config.identity?.email ?? "");
  const [importPath, setImportPath] = useState("");
  const [importPreview, setImportPreview] = useState<{ path: string; filesToRead: number; sample: string[]; skippedCount: number; note: string } | null>(null);
  const { busy, run } = useAction();
  useEffect(() => {
    if (!path && defaults.data) setPath(defaults.data.suggestion);
  }, [defaults.data, path]);
  const doPreview = async () => {
    setErr(null);
    try {
      setPreview(await post<Preview>("/setup/data-folder/preview", { path }));
    } catch (e) {
      setPreview(null);
      setErr(e as ApiError);
    }
  };
  const save = () =>
    run("save", async () => {
      await post("/setup/data-folder", { path });
      if (name.trim()) await post("/setup/identity", { name: name.trim(), email: email.trim(), confirm: true });
      if (importPreview) await post("/import", { path: importPreview.path });
      onNext();
    });
  return (
    <section className="stack">
      <h1>Where should Jarvis keep your knowledge?</h1>
      <p className="muted">Jarvis stores memory as plain Markdown in a folder you choose. You can open it in Obsidian or any editor. Settings, jobs and credentials stay outside this folder.</p>
      <div className="card stack">
        <label className="field">
          Data folder
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input value={path} onChange={(e) => { setPath(e.target.value); setPreview(null); }} spellCheck={false} aria-describedby="folder-help" />
            <button onClick={doPreview} disabled={!path.trim()}>
              Preview
            </button>
          </div>
          <span className="help" id="folder-help">A new or existing folder. Existing Markdown files are indexed but never modified.</span>
        </label>
        <ErrorState error={err} />
        {preview && (
          <div className={`state ${preview.writable ? "partial" : "error"}`} style={{ borderColor: preview.writable ? "var(--border-strong)" : undefined }} aria-live="polite">
            <strong style={{ color: "var(--text)" }}>{preview.exists ? "Existing folder" : "New folder"}: {preview.path}</strong>
            <span className="small">{preview.note}</span>
            {preview.willCreate.length > 0 && <span className="small">Will create: {preview.willCreate.join(", ")}</span>}
            <span className="small">Will modify: {preview.willModify.length ? preview.willModify.join(", ") : "nothing"}</span>
            {!preview.writable && <span className="error-text small">Jarvis cannot write here. Choose another folder.</span>}
          </div>
        )}
      </div>
      <div className="card stack">
        <h3>Import an existing Markdown folder or Obsidian vault (optional)</h3>
        <p className="small muted">Jarvis reads it in place and cites it. It does not copy, change or move anything in that folder.</p>
        <div className="row" style={{ flexWrap: "nowrap" }}>
          <input value={importPath} onChange={(e) => { setImportPath(e.target.value); setImportPreview(null); }} placeholder="/Users/you/Documents/Notes" spellCheck={false} aria-label="Folder to import" />
          <button disabled={!importPath.trim()} onClick={() => run("ip", async () => setImportPreview(await post("/import/preview", { path: importPath })))}>
            Preview import
          </button>
        </div>
        {importPreview && (
          <div className="state partial small">
            <strong style={{ color: "var(--text)" }}>Will read {importPreview.filesToRead} Markdown file(s) from {importPreview.path}</strong>
            <span>{importPreview.note}</span>
            {importPreview.skippedCount > 0 && <span>{importPreview.skippedCount} item(s) skipped (hidden folders, links or large files).</span>}
            {importPreview.sample.length > 0 && <span className="mono">{importPreview.sample.slice(0, 5).join(", ")}{importPreview.filesToRead > 5 ? ", …" : ""}</span>}
            <span>Files changed in that folder: 0</span>
          </div>
        )}
      </div>
      <div className="card stack">
        <h3>Who is this for? (optional)</h3>
        <p className="small muted">Used to tell your own messages from others'. Stored as a protected identity record that only Settings can change.</p>
        <div className="grid-2">
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
          <label className="field">
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
          </label>
        </div>
      </div>
      <Nav onNext={save} nextLabel={busy ? "Saving…" : "Use this folder"} disabled={!preview?.writable || busy !== null} />
    </section>
  );
}

export function FeatureList({ caps, onChanged }: { caps: Caps; onChanged: () => void }) {
  const { run } = useAction();
  const [problem, setProblem] = useState<{ id: string; on: boolean; message: string } | null>(null);
  const toggle = async (id: string, on: boolean, cascade = false) => {
    try {
      await put("/features", { changes: { [id]: on }, cascade });
      setProblem(null);
      onChanged();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === "dependency") setProblem({ id, on, message: err.message });
      else throw e;
    }
  };
  return (
    <div className="card" role="group" aria-label="Features">
      {caps.features.map((f) => (
        <div key={f.id} className="feature-row" data-feature={f.id}>
          <input type="checkbox" id={`f-${f.id}`} checked={f.enabled} disabled={f.core} onChange={(e) => void run(`f-${f.id}`, () => toggle(f.id, e.target.checked))} style={{ marginTop: 4, width: 16, height: 16, accentColor: "var(--accent-strong)" }} />
          <div style={{ flex: 1 }}>
            <label htmlFor={`f-${f.id}`} className="row" style={{ cursor: f.core ? "default" : "pointer" }}>
              <strong>{f.label}</strong>
              {f.core && <span className="pill">core</span>}
              <StatusPill state={f.readiness} label={f.readiness.replace(/_/g, " ")} />
            </label>
            <p className="desc">{f.description}</p>
            {(f.dependsOn.features.length > 0 || f.dependsOn.connections.length > 0) && (
              <p className="deps">
                Needs: {[...f.dependsOn.features.map((d) => caps.features.find((x) => x.id === d)?.label ?? d), ...f.dependsOn.connections.map((c) => `${c.label}${c.required ? "" : " (optional)"}`)].join(" · ")}
              </p>
            )}
            {f.enabled && f.reason && <p className="small" style={{ color: f.readiness === "ready" ? "var(--muted)" : "var(--warn)", marginTop: 4 }}>{f.reason}</p>}
            {problem?.id === f.id && (
              <div className="state partial small" style={{ marginTop: 8 }} role="alert">
                <span>{problem.message}</span>
                <div className="row">
                  <button className="small primary" onClick={() => void run("cascade", () => toggle(problem.id, problem.on, true))}>
                    {problem.on ? "Turn on what it needs too" : "Also turn off what depends on it"}
                  </button>
                  <button className="small ghost" onClick={() => setProblem(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function FeaturesStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const caps = useResource<Caps>("/capabilities", ["config.changed", "connections.changed"]);
  return (
    <section className="stack">
      <h1>Choose what Jarvis does</h1>
      <p className="muted">Conversation and search are the core and work with just your notes. Everything else is optional, and you can change it later in Settings.</p>
      {caps.loading && !caps.data && <Loading />}
      <ErrorState error={caps.error} retry={caps.reload} />
      {caps.data && <FeatureList caps={caps.data} onChanged={caps.reload} />}
      <Nav onBack={onBack} onNext={onNext} />
    </section>
  );
}

const SOURCE_KINDS = ["github", "jira", "confluence", "slack", "gmail", "gcal"];
const AGENT_KINDS = ["claude-code", "codex", "antigravity"];

function ConnectionsStep({ onBack, onNext }: { onBack: () => void; onNext: () => void }) {
  const caps = useResource<Caps>("/capabilities", ["connections.changed"]);
  const loc = useLocation();
  const oauth = loc.search.get("oauth");
  return (
    <section className="stack">
      <h1>Connect sources (optional)</h1>
      <p className="muted">Connect only what you want Jarvis to watch. Every connection starts read-only; writing is authorised separately, per action. You can skip this and connect later.</p>
      {oauth && <div className={`state ${oauth === "ok" ? "partial" : "error"} small`}>{loc.search.get("message")}</div>}
      {caps.loading && !caps.data && <Loading />}
      <ErrorState error={caps.error} retry={caps.reload} />
      {caps.data && SOURCE_KINDS.map((k) => <SetupCard key={k} kind={k} caps={caps.data!} onChanged={caps.reload} />)}
      <h2>Coding agents</h2>
      <p className="muted">Connect the coding agents you use. Jarvis saves each session in your data folder with a short summary of what was decided, and gives every new session your memory. Only Jarvis's own hooks are added to the agent's settings; everything else in them is left as it is.</p>
      {caps.data && AGENT_KINDS.map((k) => <SetupCard key={k} kind={k} caps={caps.data!} onChanged={caps.reload} />)}
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
  const voiceOn = caps.data?.features.find((f) => f.id === "voice")?.enabled;
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
      <h1>Model, voice and schedules</h1>
      <h2>Model</h2>
      <p className="muted small">A model writes answers, briefings and drafts from your evidence. Without one, Jarvis still searches and shows the evidence it finds.</p>
      {card("model")}
      {voiceOn ? (
        <>
          <h2>Voice</h2>
          <VoiceModelHelper />
          {card("speech")}
        </>
      ) : (
        <p className="small muted">Voice is off. Turn it on in the Features step to set up speech.</p>
      )}
      {attentionOn && (
        <>
          <h2>Schedules</h2>
          <div className="card grid-2">
            <label className="field">
              Refresh sources every (minutes)
              <input type="number" min={5} max={1440} value={sched.syncEveryMinutes} onChange={(e) => setSched({ ...sched, syncEveryMinutes: Math.max(5, Number(e.target.value) || 30) })} />
            </label>
            <label className="field">
              Daily briefing at
              <input type="time" value={sched.briefingAt} onChange={(e) => setSched({ ...sched, briefingAt: e.target.value })} disabled={!sched.briefingEnabled} />
            </label>
            <label className="check small">
              <input type="checkbox" checked={sched.briefingEnabled} onChange={(e) => setSched({ ...sched, briefingEnabled: e.target.checked })} /> Prepare a daily briefing
            </label>
            <label className="check small">
              <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Show a macOS notification for new urgent items
            </label>
          </div>
          <p className="small muted">Schedules run in the Jarvis service, not the browser. If the Mac sleeps, missed runs are caught up once when it wakes.</p>
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

function VoiceModelHelper() {
  const st = useResource<{ environment: { whisperBin: string | null; whisperModel: string | null; download: { state: string; received: number; total: number; error: string | null }; say: boolean } }>("/voice/status", ["speech.download"]);
  const { run } = useAction();
  useEffect(() => {
    if (st.data?.environment.download.state !== "downloading") return;
    const t = setInterval(st.reload, 1500);
    return () => clearInterval(t);
  }, [st.data?.environment.download.state, st.reload]);
  const env = st.data?.environment;
  if (!env) return null;
  const d = env.download;
  return (
    <div className="card small stack-sm">
      <div className="row">
        <span>Local recognition (whisper.cpp):</span>
        {env.whisperBin ? <StatusPill state="ready" label="installed" /> : <StatusPill state="needs_setup" label="not installed" />}
        {!env.whisperBin && <span className="muted">Install once with <code>brew install whisper-cpp</code>, then test again.</span>}
      </div>
      <div className="row">
        <span>Recognition model (148 MB):</span>
        {env.whisperModel ? <StatusPill state="ready" label="downloaded" /> : d.state === "downloading" ? <StatusPill state="running" label={`downloading ${Math.round((d.received / d.total) * 100)}%`} /> : <button className="small" onClick={() => run("dl", () => post("/voice/model/download").then(st.reload))}>Download</button>}
        {d.state === "failed" && <span className="error-text">Download failed: {d.error}</span>}
      </div>
      <div className="row">
        <span>macOS voice:</span>
        {env.say ? <StatusPill state="ready" label="available" /> : <StatusPill state="unavailable" label="not available" />}
      </div>
    </div>
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
      <p className="muted">Jarvis tests each connection you set up. Anything not ready stays visible in Settings; you can finish now and fix it later.</p>
      {testing && <Loading lines={5} label="Testing configuration" />}
      <ErrorState error={err} retry={test} />
      {result && (
        <>
          <div className="card">
            <h3>Features</h3>
            <div className="list">
              {result.features.filter((f) => f.enabled).map((f) => (
                <div key={f.id} className="row" style={{ padding: "7px 0", borderBottom: "1px solid var(--border)" }} data-feature-status={f.id}>
                  <span style={{ minWidth: 190 }}>{f.label}</span>
                  <StatusPill state={f.readiness} label={f.readiness.replace(/_/g, " ")} />
                  <span className="small muted">{f.reason ?? ""}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="card">
            <h3>Connections</h3>
            {result.connections.length === 0 ? (
              <p className="small muted">No connections. Jarvis will work as a notes-only workspace.</p>
            ) : (
              result.connections.map((c) => (
                <div key={c.id} className="row" style={{ padding: "7px 0" }}>
                  <span style={{ minWidth: 190 }}>{c.label}</span>
                  <StatusPill state={c.ok ? "ready" : c.state} label={c.ok ? "ready" : c.state.replace(/_/g, " ")} />
                  <span className="small muted">{c.message}</span>
                </div>
              ))
            )}
          </div>
        </>
      )}
      <div className="row">
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
      </div>
    </section>
  );
}
