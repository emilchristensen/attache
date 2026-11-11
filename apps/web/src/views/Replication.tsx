import { useState, type FormEvent } from "react";
import type { ReplicationStatus, ReplicationView } from "@jarvis/contracts";
import { post, type ApiError } from "../api.ts";
import { useResource } from "../live.ts";
import { ErrorState, Loading, StatusPill, Time, useAction } from "../components/ui.tsx";
import { ReplicationMachines } from "./ReplicationMachines.tsx";

const PILL: Record<ReplicationStatus, { state: string; label: string }> = {
  off: { state: "off", label: "off" },
  up_to_date: { state: "ok", label: "up to date" },
  offline: { state: "partial", label: "offline" },
  unauthorized: { state: "error", label: "unauthorized" },
  blocked: { state: "error", label: "blocked" },
};

/** What a status means and what the owner can do about it; the cause from the service is shown above it. */
const PROBLEM: Partial<Record<ReplicationStatus, { title: string; todo: string; tone: "partial" | "error" }>> = {
  offline: {
    title: "The repository cannot be reached",
    todo: "Saves carry on here and are sent when the repository can be reached again. Nothing to do unless this lasts: then check the network and the repository address.",
    tone: "partial",
  },
  unauthorized: {
    title: "The repository refused this Machine",
    todo: "Make sure this Machine may push to the repository: reconnect GitHub under Connections, or sign git in to it. Then select Check now.",
    tone: "error",
  },
  blocked: {
    title: "Replication is blocked",
    todo: "Nothing is sent or received until the cause is fixed. Saves carry on here. Fix the cause, then select Check now.",
    tone: "error",
  },
};

const REPOSITORY_HELP = "A private repository on GitHub: owner/name, or its https:// or ssh:// address. A folder path works too.";

function useSubmit(onDone: (v: ReplicationView) => void) {
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent, send: () => Promise<ReplicationView>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    send()
      .then(onDone)
      .catch((err: ApiError) => setError(err))
      .finally(() => setBusy(false));
  };
  return { error, busy, submit };
}

function RepositoryField({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  return (
    <label className="field">
      Repository
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="you/brain" spellCheck={false} autoComplete="off" aria-describedby={`${id}-help`} />
      <span className="help" id={`${id}-help`}>
        {REPOSITORY_HELP}
      </span>
    </label>
  );
}

function StartForm({ onDone }: { onDone: (v: ReplicationView) => void }) {
  const [remote, setRemote] = useState("");
  const { error, busy, submit } = useSubmit(onDone);
  return (
    <form className="stack" onSubmit={(e) => submit(e, () => post<ReplicationView>("/replication/setup", { remote }))}>
      <p className="small muted">Sends this Machine's Brain to an empty repository. Other Machines then join it from their own Dashboard.</p>
      <RepositoryField id="start-repo" value={remote} onChange={setRemote} />
      <ErrorState error={error} title="Replication was not set up" />
      <div>
        <button type="submit" className="primary" disabled={busy || !remote.trim()}>
          {busy ? "Setting up…" : "Set up Replication"}
        </button>
      </div>
    </form>
  );
}

/** Clone a Brain another Machine set up into an empty folder, which becomes this Machine's data folder. */
export function JoinForm({ onDone, folder: fixedFolder, intro, primary = true }: { onDone: (v: ReplicationView) => void; folder?: string; intro: string; primary?: boolean }) {
  const [remote, setRemote] = useState("");
  const [folder, setFolder] = useState("");
  const target = fixedFolder ?? folder;
  const { error, busy, submit } = useSubmit(onDone);
  return (
    <form className="stack" onSubmit={(e) => submit(e, () => post<ReplicationView>("/replication/join", { remote, path: target }))}>
      <p className="small muted">{intro}</p>
      <RepositoryField id="join-repo" value={remote} onChange={setRemote} />
      {fixedFolder === undefined && (
        <label className="field">
          Empty folder for the Brain
          <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="/Users/you/Documents/Brain" spellCheck={false} aria-describedby="join-folder-help" />
          <span className="help" id="join-folder-help">
            Jarvis clones the Brain here and uses this folder from then on. It must be empty or new, so two Brains are never mixed; the current data folder is left as it is.
          </span>
        </label>
      )}
      <ErrorState error={error} title="Could not join" />
      <div>
        <button type="submit" className={primary ? "primary" : undefined} disabled={busy || !remote.trim() || !target.trim()}>
          {busy ? "Joining…" : fixedFolder === undefined ? "Join" : "Join into this folder"}
        </button>
      </div>
    </form>
  );
}

function SwitchOn({ onDone }: { onDone: (v: ReplicationView) => void }) {
  const [mode, setMode] = useState<"start" | "join">("start");
  const tab = (id: typeof mode, label: string) => (
    <button type="button" role="tab" id={`replication-tab-${id}`} aria-selected={mode === id} aria-controls="replication-panel" onClick={() => setMode(id)}>
      {label}
    </button>
  );
  return (
    <div>
      <div className="tabs" role="tablist" aria-label="How to switch Replication on">
        {tab("start", "Start with this Brain")}
        {tab("join", "Join another Machine")}
      </div>
      <div role="tabpanel" id="replication-panel" aria-labelledby={`replication-tab-${mode}`}>
        {mode === "start" ? <StartForm onDone={onDone} /> : <JoinForm onDone={onDone} intro="Brings the Brain another Machine set up onto this one." />}
      </div>
    </div>
  );
}

function Problem({ view }: { view: ReplicationView }) {
  const p = PROBLEM[view.status];
  if (!p) return null;
  return (
    <div className={`state ${p.tone} replication-problem`} role={p.tone === "error" ? "alert" : "status"} data-replication-problem={view.status}>
      <strong>{p.title}</strong>
      {view.cause && <span className="small replication-cause">{view.cause}</span>}
      <span className="small">
        <b>What to do:</b> {p.todo}
      </span>
    </div>
  );
}

function SwitchOff({ dataFolder, onDone }: { dataFolder: string | null; onDone: (v: ReplicationView) => void }) {
  const [asking, setAsking] = useState(false);
  const { busy, run } = useAction();
  if (!asking)
    return (
      <button className="ghost danger" onClick={() => setAsking(true)}>
        Switch off
      </button>
    );
  return (
    <div className="state partial replication-off-confirm" role="group" aria-label="Switch Replication off">
      <strong>Switch Replication off on this Machine?</strong>
      <span className="small">
        The Brain stays in {dataFolder ? <span className="mono">{dataFolder}</span> : "the data folder"} with its history. New saves stay on this Machine until you set Replication up again with the same repository. Other Machines keep their copies.
      </span>
      <div className="row">
        <button className="danger" disabled={busy !== null} onClick={() => void run("off", () => post<ReplicationView>("/replication/off").then(onDone), "Replication is off on this Machine")}>
          {busy ? "Switching off…" : "Switch off"}
        </button>
        <button className="ghost" disabled={busy !== null} onClick={() => setAsking(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function On({ view, dataFolder, onChanged }: { view: ReplicationView; dataFolder: string | null; onChanged: (v: ReplicationView) => void }) {
  const { busy, run } = useAction();
  return (
    <>
      <dl className="kv replication-facts">
        <dt>Repository</dt>
        <dd className="mono">{view.remote}</dd>
        <dt>Last up to date</dt>
        <dd data-up-to-date>{view.upToDateAt ? <Time iso={view.upToDateAt} /> : "not yet"}</dd>
        <dt>Last checked</dt>
        <dd>
          <Time iso={view.lastCheckedAt} />
        </dd>
        <dt>Last sent</dt>
        <dd>{view.lastPushedAt ? <Time iso={view.lastPushedAt} /> : "nothing sent from this Machine yet"}</dd>
      </dl>
      <Problem view={view} />
      <div className="row">
        <button disabled={busy !== null} onClick={() => void run("check", () => post<ReplicationView>("/replication/check").then(onChanged))}>
          {busy ? "Checking…" : "Check now"}
        </button>
        <span style={{ flex: 1 }} />
        <SwitchOff dataFolder={dataFolder} onDone={onChanged} />
      </div>
      <ReplicationMachines />
    </>
  );
}

/** Replication on this Machine: set it up or join, watch its status and the other Machines, or switch it off. */
export function ReplicationCard({ dataFolder }: { dataFolder: string | null }) {
  const view = useResource<ReplicationView>("/replication", ["replication.changed", "config.changed"]);
  const v = view.data;
  const pill = v ? PILL[v.status] : null;
  return (
    <section className="card stack" aria-labelledby="replication-title" data-replication={v?.status}>
      <div className="row">
        <h3 id="replication-title" style={{ flex: 1 }}>
          Replication
        </h3>
        {pill && <StatusPill state={pill.state} label={pill.label} />}
      </div>
      <p className="small muted">Keeps the Brain the same on every Machine you own, with its history, through a private git repository. Drafts, approvals, connections and secrets stay on the Machine they were made on.</p>
      {view.loading && !v && <Loading lines={2} />}
      <ErrorState error={view.error} retry={view.reload} />
      {v?.status === "off" && <SwitchOn onDone={view.setData} />}
      {v && v.status !== "off" && <On view={v} dataFolder={dataFolder} onChanged={view.setData} />}
    </section>
  );
}
