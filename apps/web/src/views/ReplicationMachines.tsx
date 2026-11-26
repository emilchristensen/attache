import type { ReaderView, ReplicatedMachineView, ReplicationMachinesView } from "@attache/contracts";
import { put } from "../api.ts";
import { useResource } from "../live.ts";
import { ErrorState, Loading, Time, useAction } from "../components/ui.tsx";
import { Tag } from "../components/Tag.tsx";
import { READER_EVENTS } from "./ReaderLine.tsx";

function MachineRow({ m, preferred, reader, busy, onStandby }: { m: ReplicatedMachineView; preferred: boolean; reader: "active" | "silent" | null; busy: boolean; onStandby: (on: boolean) => void }) {
  return (
    <li className="machine-row" data-machine={m.name}>
      <div className="machine-head">
        <strong className="machine-name">{m.name}</strong>
        {m.thisMachine && <Tag hue="blue">this Machine</Tag>}
        {reader === "active" && <span className="state-text">Reader</span>}
        {reader === "silent" && <Tag hue="amber">Reader, silent</Tag>}
        {preferred && <Tag>Preferred Reader</Tag>}
        {m.standby && <Tag>standby</Tag>}
      </div>
      <p className="small muted">
        <span data-machine-version>{m.version ? `Attache ${m.version}` : "Version unknown"}</span>
        {" · "}
        {m.lastChangeAt ? (
          <>
            Last change <Time iso={m.lastChangeAt} />
          </>
        ) : (
          "No changes in the shared history yet"
        )}
      </p>
      {m.thisMachine && (
        <label className="check small machine-standby">
          <input type="checkbox" checked={m.standby} disabled={busy} onChange={(e) => onStandby(e.target.checked)} />
          <span>
            <strong>Standby</strong>
            <span className="muted"> · becomes the Reader once the Reader is silent for 30 minutes, if a source is connected here</span>
          </span>
        </label>
      )}
    </li>
  );
}

/** The Machines sharing the Brain, this Machine's standby flag and the Preferred Reader, all recorded in the Brain. */
export function ReplicationMachines() {
  const list = useResource<ReplicationMachinesView>("/replication/machines", ["replication.changed", "config.changed"]);
  const reader = useResource<ReaderView>("/reader", READER_EVENTS).data;
  const { busy, run } = useAction();
  const data = list.data;
  const setStandby = (on: boolean) => void run("standby", () => put<ReplicationMachinesView>("/replication/standby", { standby: on }).then(list.setData), on ? "This Machine is on standby" : "This Machine is no longer on standby");
  const setPreferred = (id: string) =>
    void run("preferred", () => put<ReplicationMachinesView>("/replication/preferred-reader", { machine: id || null }).then(list.setData), id ? "Preferred Reader chosen" : "No Preferred Reader");
  const unknownPreferred = !!data?.preferredReader && !data.machines.some((m) => m.id === data.preferredReader);
  return (
    <div className="stack-sm" aria-labelledby="machines-title" role="group">
      <h4 id="machines-title">Machines</h4>
      {list.loading && !data && <Loading lines={2} />}
      <ErrorState error={list.error} retry={list.reload} />
      {data && (
        <>
          <ul className="machine-list">
            {data.machines.map((m) => (
              <MachineRow key={m.id} m={m} preferred={m.id === data.preferredReader} reader={reader?.machine?.id === m.id ? (reader.silent ? "silent" : "active") : null} busy={busy !== null} onStandby={setStandby} />
            ))}
          </ul>
          <label className="field preferred-reader">
            Preferred Reader
            <select value={data.preferredReader ?? ""} disabled={busy !== null} onChange={(e) => setPreferred(e.target.value)} aria-describedby="preferred-reader-help">
              <option value="">None chosen</option>
              {unknownPreferred && <option value={data.preferredReader!}>A Machine no longer listed</option>}
              {data.machines.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.thisMachine ? " (this Machine)" : ""}
                </option>
              ))}
            </select>
            <span className="help" id="preferred-reader-help">
              Runs Source refresh and briefings whenever it is online. Choose one that is usually on. Recorded in the Brain, so every Machine agrees.
            </span>
          </label>
        </>
      )}
    </div>
  );
}
