import type { ReplicatedMachineView, ReplicationMachinesView } from "@attache/contracts";
import type { MachineIdentity } from "../core/machine.ts";
import type { Clock } from "./clock.ts";
import { READABLE_BRAIN_FORMAT } from "./brain-format.ts";
import { MachineRecords, type MachineRecord } from "./machine-records.ts";
import { ReplicationSetupError } from "./setup.ts";

/** A Machine rewrites its record at least this often while running, so the record's time says when it was last heard from. */
export const RECORD_REFRESH_MS = 7 * 24 * 60 * 60_000;

export interface ReplicatedMachinesDeps {
  /** The data folder Replication is on for; null while it is off. */
  root: () => string | null;
  machine: () => MachineIdentity;
  /** The Attache version this Machine runs. */
  version: string;
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
    const version = this.deps.version;
    if (!root) return { machines: [{ id: me.id, name: me.name, standby: false, thisMachine: true, version, lastChangeAt: null }], preferredReader: null };
    const records = new MachineRecords(root);
    const listed = records.machines();
    const mine = listed.find((r) => r.id === me.id) ?? { id: me.id, name: me.name, standby: false };
    const others = listed.filter((r) => r.id !== me.id).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    // This Machine shows what it runs and is called now, even before its record says so.
    const show = (r: Pick<MachineRecord, "id" | "name" | "standby" | "version">): ReplicatedMachineView => ({
      id: r.id,
      name: r.id === me.id ? me.name : r.name,
      standby: r.standby,
      thisMachine: r.id === me.id,
      version: r.id === me.id ? version : (r.version ?? null),
      lastChangeAt: this.deps.lastChangeBy(root, r.id),
    });
    return { machines: [mine, ...others].map(show), preferredReader: records.preferredReader() };
  }

  /**
   * Make this Machine's record say its current name, version and readable Brain
   * format, keeping its standby flag; commit and send it like a save.
   */
  recordThisMachine(root = this.deps.root()): void {
    if (root && this.refresh(root)) this.deps.written();
  }

  /**
   * Write this Machine's record when it no longer says what this Machine
   * is now, or is a week old. Returns whether it wrote; the caller commits it.
   */
  refresh(root: string, standby?: boolean): boolean {
    const records = new MachineRecords(root);
    const me = this.deps.machine();
    const current = records.machine(me.id);
    const wanted = { id: me.id, name: me.name, standby: standby ?? current?.standby ?? false, version: this.deps.version, readsBrainFormat: READABLE_BRAIN_FORMAT };
    if (current && !this.stale(current) && (Object.keys(wanted) as Array<keyof typeof wanted>).every((k) => current[k] === wanted[k])) return false;
    records.writeMachine({ ...wanted, updatedAt: this.now() }, records.unknownFields(me.id));
    return true;
  }

  setStandby(standby: boolean): ReplicationMachinesView {
    const root = this.records().root;
    if (this.refresh(root, standby)) this.deps.written();
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

  private stale(record: MachineRecord): boolean {
    return this.deps.clock.now().getTime() - Date.parse(record.updatedAt) >= RECORD_REFRESH_MS;
  }

  private now(): string {
    return this.deps.clock.now().toISOString();
  }
}
