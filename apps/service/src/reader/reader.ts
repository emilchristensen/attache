import type { ReaderView } from "@attache/contracts";
import type { MachineIdentity } from "../core/machine.ts";
import type { Clock } from "../replication/clock.ts";
import { hasLapsed, later, type LeaseRecord } from "./lease.ts";

/**
 * This Machine's part in reading the sources:
 * - `reader`: it runs scheduled Source refresh, briefings and Review-date inbox items;
 * - `lapsed`: it holds the lease but has not renewed it for 30 minutes (asleep or offline),
 *   so it waits for the next renewal before reading again;
 * - `other`: another Machine is the Reader, or none is known yet.
 */
export type ReaderRole = "reader" | "lapsed" | "other";

export interface ReaderDeps {
  clock: Clock;
  machine: () => MachineIdentity;
  /** Whether Replication is on; a Machine without it is its own Reader. */
  replicated: () => boolean;
  /** The lease as this Machine last heard it. */
  lease: () => LeaseRecord | null;
  /** A Machine's name as its record in the Brain says. */
  machineName: (id: string) => string | null;
  /** This Machine's last Source refresh of every source. */
  lastRefreshAt: () => string | null;
}

/** Which Machine reads the sources, as this Machine sees it. */
export class Reader {
  private readonly deps: ReaderDeps;

  constructor(deps: ReaderDeps) {
    this.deps = deps;
  }

  role(): ReaderRole {
    if (!this.deps.replicated()) return "reader";
    const lease = this.deps.lease();
    if (!lease || lease.holder !== this.deps.machine().id) return "other";
    return hasLapsed(lease, this.deps.clock.now()) ? "lapsed" : "reader";
  }

  isReader(): boolean {
    return this.role() === "reader";
  }

  view(): ReaderView {
    const me = this.deps.machine();
    const local = this.deps.lastRefreshAt();
    if (!this.deps.replicated()) return { machine: { id: me.id, name: me.name }, thisMachine: true, replicated: false, heartbeatAt: null, silent: false, lastRefreshAt: local };
    const lease = this.deps.lease();
    if (!lease) return { machine: null, thisMachine: false, replicated: true, heartbeatAt: null, silent: false, lastRefreshAt: null };
    const mine = lease.holder === me.id;
    return {
      machine: { id: lease.holder, name: mine ? me.name : (this.deps.machineName(lease.holder) ?? lease.name) },
      thisMachine: mine,
      replicated: true,
      heartbeatAt: lease.renewedAt,
      silent: hasLapsed(lease, this.deps.clock.now()),
      lastRefreshAt: mine ? later(lease.lastRefreshAt, local) : lease.lastRefreshAt,
    };
  }
}
