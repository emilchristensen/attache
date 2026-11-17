import type { ReplicatedMachineView, ReplicationMachinesView } from "@attache/contracts";
import type { MachineIdentity } from "../core/machine.ts";
import type { Clock } from "./clock.ts";
import { MachineRecords, type MachineRecord } from "./machine-records.ts";
import { ReplicationSetupError } from "./setup.ts";

export interface ReplicatedMachinesDeps {
  /** The data folder Replication is on for; null while it is off. */
  root: () => string | null;
  machine: () => MachineIdentity;
  clock: Clock;
  /** When the Machine with this id last changed the Brain, from the history in `root`. */
  lastChangeBy: (root: string, id: string) => string | null;
  /** A record was written: commit and send it like a save. */
  written: () => void;
}

const OFF_MESSAGE = "Replication is off on this Machine. A Machine on its own is its own Reader; set Replication up first.";

/**
 * The Machines that share the Brain, as their records in the Brain say: this
 * Machine's name and standby flag, the others', and the Preferred Reader.
 */
export class ReplicatedMachines {
  private readonly deps: ReplicatedMachinesDeps;

  constructor(deps: ReplicatedMachinesDeps) {
    this.deps = deps;
  }

  view(): ReplicationMachinesView {
    const me = this.deps.machine();
    const root = this.deps.root();
    if (!root) return { machines: [{ id: me.id, name: me.name, standby: false, thisMachine: true, lastChangeAt: null }], preferredReader: null };
    const records = new MachineRecords(root);
    const listed = records.machines();
    const mine = listed.find((r) => r.id === me.id) ?? { id: me.id, name: me.name, standby: false, updatedAt: "" };
    const others = listed.filter((r) => r.id !== me.id).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const show = (r: Pick<MachineRecord, "id" | "name" | "standby">): ReplicatedMachineView => ({
      id: r.id,
      name: r.id === me.id ? me.name : r.name,
      standby: r.standby,
      thisMachine: r.id === me.id,
      lastChangeAt: this.deps.lastChangeBy(root, r.id),
    });
    return { machines: [mine, ...others].map(show), preferredReader: records.preferredReader() };
  }

  /** Make this Machine's record say its current name, keeping its standby flag. Writes only when something changed. */
  recordThisMachine(root = this.deps.root()): void {
    if (!root) return;
    const me = this.deps.machine();
    const records = new MachineRecords(root);
    const current = records.machine(me.id);
    if (current && current.name === me.name) return;
    records.writeMachine({ id: me.id, name: me.name, standby: current?.standby ?? false, updatedAt: this.now() });
    this.deps.written();
  }

  setStandby(standby: boolean): ReplicationMachinesView {
    const records = this.records();
    const me = this.deps.machine();
    const current = records.machine(me.id);
    if (!current || current.standby !== standby || current.name !== me.name) {
      records.writeMachine({ id: me.id, name: me.name, standby, updatedAt: this.now() });
      this.deps.written();
    }
    return this.view();
  }

  setPreferredReader(machine: string | null): ReplicationMachinesView {
    const records = this.records();
    if (machine !== null && !this.view().machines.some((m) => m.id === machine)) {
      throw new ReplicationSetupError(400, "unknown_machine", "That Machine is not one of the Machines sharing this Brain. Choose one from the list.");
    }
    if (records.preferredReader() !== machine) {
      records.writePreferredReader({ machine, updatedAt: this.now(), by: this.deps.machine().id });
      this.deps.written();
    }
    return this.view();
  }

  private records(): MachineRecords {
    const root = this.deps.root();
    if (!root) throw new ReplicationSetupError(409, "replication_off", OFF_MESSAGE);
    return new MachineRecords(root);
  }

  private now(): string {
    return this.deps.clock.now().toISOString();
  }
}
