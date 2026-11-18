import { useEffect, useState } from "react";
import type { Config, ConnectionDefinition, ConnectionStatus, FeatureStatus, MachineView } from "@attache/contracts";
import { del, patch, post } from "../api.ts";
import { useResource } from "../live.ts";
import { ErrorState, Loading, Time, useAction } from "../components/ui.tsx";
import { StateTag } from "../components/StateTag.tsx";
import { Tag } from "../components/Tag.tsx";
import { AutoAccept } from "./AutoAccept.tsx";
import { ReplicationCard } from "./Replication.tsx";
import { FeatureList } from "./Setup.tsx";
import { MeaningSearchCard } from "./MeaningSearch.tsx";

interface Caps {
  features: FeatureStatus[];
  connections: ConnectionStatus[];
  definitions: ConnectionDefinition[];
}
interface Status {
  version: string;
  instance: string;
  startedAt: string;
  pid: number;
  node: string;
  stateDir: string;
  dataFolder: string | null;
  credentialStore: "keychain" | "secret-service" | "credential-manager" | "file";
  /** Why this store is in use when it is not the operating system's own. */
  credentialStoreNote: string | null;
  documents: number;
  jobs: Array<{ status: string; n: number }>;
  schedules: Array<{ id: string; label: string; enabled: boolean; nextRunAt: string | null; lastRunAt: string | null }>;
}

const CREDENTIAL_STORES: Record<Status["credentialStore"], string> = {
  keychain: "macOS Keychain",
  "secret-service": "Secret Service (desktop keyring)",
  "credential-manager": "Windows Credential Manager",
  file: "Private file (only you can read it)",
};

function Schedules({ config, onSaved }: { config: Config; onSaved: () => void }) {
  const [s, setS] = useState(config.schedules);
  const [n, setN] = useState(config.notifications.desktop);
  const { busy, run } = useAction();
  useEffect(() => setS(config.schedules), [config.schedules]);
  return (
    <div className="card stack">
      <h3>Schedules and notifications</h3>
      <div className="grid-2">
        <label className="field">
          Refresh sources every (minutes)
          <input type="number" min={5} max={1440} value={s.refreshEveryMinutes} onChange={(e) => setS({ ...s, refreshEveryMinutes: Math.max(5, Number(e.target.value) || 30) })} />
        </label>
        <label className="field">
          Daily briefing at
          <input type="time" value={s.briefingAt} disabled={!s.briefingEnabled} onChange={(e) => setS({ ...s, briefingAt: e.target.value })} />
        </label>
      </div>
      <label className="check small">
        <input type="checkbox" checked={s.briefingEnabled} onChange={(e) => setS({ ...s, briefingEnabled: e.target.checked })} /> Prepare a daily briefing
      </label>
      <label className="check small">
        <input type="checkbox" checked={n} onChange={(e) => setN(e.target.checked)} /> Desktop notification for new urgent items
      </label>
      <div>
        <button className="primary" disabled={busy !== null} onClick={() => run("s", () => patch("/config", { schedules: s, notifications: { desktop: n } }).then(onSaved), "Saved")}>
          Save
        </button>
      </div>
    </div>
  );
}

function Identity({ config, onSaved }: { config: Config; onSaved: () => void }) {
  const [name, setName] = useState(config.identity?.name ?? "");
  const [email, setEmail] = useState(config.identity?.email ?? "");
  const [confirm, setConfirm] = useState(false);
  const { busy, run } = useAction();
  return (
    <div className="card stack">
      <h3>Identity (protected)</h3>
      <p className="small muted">Stored in memory/self.md. Only this form can change it; imported documents, connectors and the model cannot.</p>
      <div className="grid-2">
        <label className="field">
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
      </div>
      <label className="check small">
        <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I want to change my protected identity record
      </label>
      <div>
        <button disabled={!confirm || !name.trim() || busy !== null} onClick={() => run("id", () => post("/setup/identity", { name, email, confirm: true }).then(() => { setConfirm(false); onSaved(); }), "Identity saved")}>
          Save identity
        </button>
      </div>
    </div>
  );
}

function ThisMachine() {
  const machine = useResource<MachineView>("/machine", ["config.changed"]);
  const [name, setName] = useState("");
  const { busy, run } = useAction();
  useEffect(() => setName(machine.data?.name ?? ""), [machine.data?.name]);
  const changed = !!machine.data && name.trim() !== machine.data.name;
  return (
    <div className="card stack">
      <h3>This Machine</h3>
      <p className="small muted">Session logs and connector snapshots written here carry this name, and with Replication on the other Machines list this one by it, so you can tell which computer a change came from.</p>
      {machine.loading && !machine.data && <Loading lines={1} />}
      <ErrorState error={machine.error} retry={machine.reload} />
      {machine.data && (
        <form
          className="stack-sm"
          onSubmit={(e) => {
            e.preventDefault();
            if (changed) void run("machine", () => patch("/machine", { name }).then(machine.reload), "Machine renamed");
          }}
        >
          <label className="field">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} data-machine-name />
          </label>
          <p className="small muted">
            Id <span className="mono">{machine.data.id}</span>
          </p>
          <div>
            <button type="submit" disabled={!changed || !name.trim() || busy !== null}>
              Rename
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function Clients() {
  const clients = useResource<Array<{ id: string; name: string; kind: string; createdAt: string; lastSeenAt: string | null; revokedAt: string | null }>>("/clients");
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const { run } = useAction();
  return (
    <div className="card stack">
      <h3>Paired clients</h3>
      <p className="small muted">Pair another browser with a one-time code. Codes expire after 10 minutes.</p>
      <div className="row">
        <button onClick={() => run("code", async () => setCode(await post("/clients/pairing-code")))}>Create pairing code</button>
        {code && (
          <span className="row">
            <span className="mono" style={{ fontSize: 18, letterSpacing: "0.12em" }} data-pairing-code>
              {code.code}
            </span>
            <span className="small muted">expires <Time iso={code.expiresAt} /></span>
          </span>
        )}
      </div>
      {clients.loading && !clients.data && <Loading lines={2} />}
      <div>
        {clients.data?.map((c) => (
          <div key={c.id} className="client-row">
            <span className="client-name">
              {c.name} <Tag>{c.kind}</Tag>
            </span>
            <span className="small muted">
              last seen <Time iso={c.lastSeenAt} />
            </span>
            {c.revokedAt ? <StateTag state="expired" label="revoked" /> : <button className="small ghost danger" onClick={() => run("rv", () => del(`/clients/${c.id}`).then(clients.reload), "Client revoked")}>Revoke</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function Backups() {
  const list = useResource<Array<{ name: string; path: string; bytes: number; createdAt: string }>>("/backups");
  const { busy, run } = useAction();
  return (
    <div className="card stack">
      <h3>Backup and export</h3>
      <p className="small muted">A backup contains your data folder and Attache's database (settings, jobs, drafts, receipts). Credentials stay in the secret store and are not exported; reconnect them after a restore.</p>
      <div>
        <button disabled={busy !== null} onClick={() => run("bk", () => post("/backups").then(list.reload), "Backup created")}>
          {busy ? "Creating…" : "Create backup now"}
        </button>
      </div>
      {list.data?.length ? (
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {list.data.map((b) => (
            <li key={b.name}>
              <span className="mono">{b.path}</span> · {(b.bytes / 1024).toFixed(0)} KB · <Time iso={b.createdAt} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">No backups yet.</p>
      )}
      <p className="small muted">
        Restore into a fresh profile with <code>attache restore &lt;file&gt; --data-folder &lt;empty folder&gt;</code>. Uninstall with <code>attache-uninstall</code>; it keeps your data unless you pass <code>--delete-data</code>.
      </p>
    </div>
  );
}

export function SettingsView() {
  const caps = useResource<Caps>("/capabilities", ["config.changed", "connections.changed"]);
  const cfg = useResource<{ config: Config }>("/config", ["config.changed"]);
  const status = useResource<Status>("/status", ["config.changed", "job"]);
  return (
    <div className="page page-narrow">
      <div className="page-header">
        <h1>Settings</h1>
        <span className="subtitle">Every choice from setup can be changed here. Turning a feature off stops its schedules and cancels its queued work.</span>
      </div>
      <div className="stack">
        <h2>Features</h2>
        {caps.loading && !caps.data && <Loading />}
        <ErrorState error={caps.error} retry={caps.reload} />
        {caps.data && <FeatureList caps={caps.data} onChanged={caps.reload} />}
        {cfg.data && (
          <>
            <Schedules config={cfg.data.config} onSaved={cfg.reload} />
            <Identity config={cfg.data.config} onSaved={cfg.reload} />
          </>
        )}
        <ThisMachine />
        <ReplicationCard dataFolder={status.data?.dataFolder ?? null} />
        <AutoAccept />
        <MeaningSearchCard />
        <Clients />
        <Backups />
        <div className="card stack-sm">
          <h3>Service health</h3>
          <ErrorState error={status.error} retry={status.reload} />
          {status.data && (
            <dl className="kv">
              <dt>Version</dt>
              <dd>{status.data.version}</dd>
              <dt>Running since</dt>
              <dd>
                <Time iso={status.data.startedAt} /> (pid {status.data.pid}, Node {status.data.node})
              </dd>
              <dt>Data folder</dt>
              <dd className="mono">{status.data.dataFolder}</dd>
              <dt>Service state</dt>
              <dd className="mono">{status.data.stateDir}</dd>
              <dt>Credentials</dt>
              <dd data-credential-store={status.data.credentialStore}>
                {CREDENTIAL_STORES[status.data.credentialStore]}
                {status.data.credentialStoreNote && <div className="small muted">{status.data.credentialStoreNote}</div>}
              </dd>
              <dt>Indexed files</dt>
              <dd>{status.data.documents}</dd>
              <dt>Jobs</dt>
              <dd>{status.data.jobs.map((j) => `${j.n} ${j.status}`).join(", ") || "none"}</dd>
              <dt>Schedules</dt>
              <dd>
                {status.data.schedules.map((s) => (
                  <div key={s.id}>
                    {s.label}: {s.enabled ? <>next <Time iso={s.nextRunAt} /></> : "off"}
                  </div>
                ))}
              </dd>
            </dl>
          )}
          <p className="small muted">If Attache stops responding, run <code>attache status</code>. Reinstalling repairs the service without touching your data.</p>
        </div>
      </div>
    </div>
  );
}
