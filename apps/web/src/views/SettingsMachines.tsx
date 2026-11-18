import { useEffect, useState } from "react";
import type { MachineView } from "@attache/contracts";
import { del, patch, post } from "../api.ts";
import { useResource } from "../live.ts";
import { ErrorState, Loading, Time, useAction } from "../components/ui.tsx";
import { StateTag } from "../components/StateTag.tsx";
import { Tag } from "../components/Tag.tsx";
import { ReplicationCard } from "./Replication.tsx";
import { SettingsSection } from "./SettingsSection.tsx";

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

/** This Machine's name, then Replication with every state and action it has. */
export function MachinesSection() {
  const status = useResource<{ dataFolder: string | null }>("/status", ["config.changed"]);
  return (
    <SettingsSection id="machines" lede="This Machine's name, and Replication: the same Brain on every Machine you own.">
      <ThisMachine />
      <ReplicationCard dataFolder={status.data?.dataFolder ?? null} />
    </SettingsSection>
  );
}

interface Client {
  id: string;
  name: string;
  kind: string;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export function ClientsSection() {
  const clients = useResource<Client[]>("/clients");
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
  const { run } = useAction();
  return (
    <SettingsSection id="clients" lede="The browsers that may use this Dashboard. Pair another one with a one-time code; codes expire after 10 minutes.">
      <div className="card stack">
        <div className="row">
          <button onClick={() => run("code", async () => setCode(await post("/clients/pairing-code")))}>Create pairing code</button>
          {code && (
            <span className="row">
              <span className="mono pairing-code" data-pairing-code>
                {code.code}
              </span>
              <span className="small muted">
                expires <Time iso={code.expiresAt} />
              </span>
            </span>
          )}
        </div>
        {clients.loading && !clients.data && <Loading lines={2} />}
        <ErrorState error={clients.error} retry={clients.reload} />
        {clients.data && clients.data.length > 0 && (
          <div>
            {clients.data.map((c) => (
              <div key={c.id} className="client-row">
                <span className="client-name">
                  {c.name} <Tag>{c.kind}</Tag>
                </span>
                <span className="small muted">
                  last seen <Time iso={c.lastSeenAt} />
                </span>
                {c.revokedAt ? (
                  <StateTag state="expired" label="revoked" />
                ) : (
                  <button className="small ghost danger" onClick={() => run("rv", () => del(`/clients/${c.id}`).then(clients.reload), "Client revoked")}>
                    Revoke
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </SettingsSection>
  );
}
