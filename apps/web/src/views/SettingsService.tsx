import { useResource } from "../live.ts";
import { Disclosure } from "../components/Disclosure.tsx";
import { ErrorState, Loading, Time } from "../components/ui.tsx";
import { SearchIndexCard } from "./RebuildIndex.tsx";
import { SettingsSection } from "./SettingsSection.tsx";

/** GET /status: the service as Service health shows it. */
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

/** What the owner checks first: the version, how long it has run, where the data and the secrets are. */
function Health({ s }: { s: Status }) {
  return (
    <dl className="kv">
      <dt>Version</dt>
      <dd>{s.version}</dd>
      <dt>Running since</dt>
      <dd>
        <Time iso={s.startedAt} standalone />
      </dd>
      <dt>Data folder</dt>
      <dd className="mono">{s.dataFolder}</dd>
      <dt>Credentials</dt>
      <dd data-credential-store={s.credentialStore}>
        {CREDENTIAL_STORES[s.credentialStore]}
        {s.credentialStoreNote && <div className="small muted">{s.credentialStoreNote}</div>}
      </dd>
    </dl>
  );
}

/** The rest of `/status`, for when something is wrong: the process, its state folder, the index, jobs and schedules. */
function Diagnostics({ s }: { s: Status }) {
  return (
    <dl className="kv" data-diagnostics>
      <dt>Process</dt>
      <dd>
        pid {s.pid}, Node {s.node}
      </dd>
      <dt>Service state</dt>
      <dd className="mono">{s.stateDir}</dd>
      <dt>Indexed files</dt>
      <dd>{s.documents}</dd>
      <dt>Jobs</dt>
      <dd>{s.jobs.map((j) => `${j.n} ${j.status}`).join(", ") || "none"}</dd>
      <dt>Schedules</dt>
      <dd>
        {s.schedules.map((sc) => (
          <div key={sc.id}>
            {sc.label}:{" "}
            {sc.enabled ? (
              <>
                next <Time iso={sc.nextRunAt} />
              </>
            ) : (
              "off"
            )}
          </div>
        ))}
      </dd>
    </dl>
  );
}

const LEDE = (
  <>
    The Attache service on this Machine: what runs, where it keeps your data and secrets, and the search index. If Attache stops responding, run <code>attache status</code>; reinstalling repairs the service without touching your data.
  </>
);

export function ServiceSection() {
  const status = useResource<Status>("/status", ["config.changed", "job"]);
  const s = status.data;
  return (
    <SettingsSection id="service" lede={LEDE}>
      <div className="card stack-sm">
        {status.loading && !s && <Loading lines={3} />}
        <ErrorState error={status.error} retry={status.reload} />
        {s && <Health s={s} />}
      </div>
      <SearchIndexCard />
      {s && (
        <Disclosure title="Diagnostics" meta="The process, its state folder, the index, jobs and schedules">
          <Diagnostics s={s} />
        </Disclosure>
      )}
    </SettingsSection>
  );
}
