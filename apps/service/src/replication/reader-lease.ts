import type { Logger } from "../core/log.ts";
import type { MachineIdentity } from "../core/machine.ts";
import type { Clock } from "./clock.ts";
import { Git } from "./git.ts";
import { authorEnv } from "./brain-repo.ts";
import { LeaseRef } from "./lease-ref.ts";
import type { GitCredentials } from "./seams.ts";
import { leaseToWrite, type LeaseRecord } from "../reader/lease.ts";

/** Write the lease again this many times when another Machine wrote it first. */
const WRITE_ATTEMPTS = 3;

export interface ReaderLeaseDeps {
  log: Logger;
  clock: Clock;
  machine: () => MachineIdentity;
  credentials: GitCredentials;
  /** The Preferred Reader recorded in the Brain at `root`. */
  preferredReader: (root: string) => string | null;
  /** Whether this Machine may take a silent Reader's place: marked standby in the Brain at `root`, with its sources connected. */
  standIn: (root: string) => boolean;
  /** Whether this Machine set up Replication of the Brain at `root`. */
  founder: (root: string) => boolean;
  /** This Machine's last Source refresh of every source. */
  lastRefreshAt: () => string | null;
  /** The lease as this Machine knows it changed. */
  onChange: () => void;
  /** Lease commits per generation before the lease moves to the next one; `LEASE_GENERATION_COMMITS` by default. */
  generationCommits?: number;
}

/**
 * This Machine's side of the Reader lease while Replication is on: what it
 * last heard, and renewing or taking the lease after each check of the remote.
 */
export class ReaderLease {
  private readonly deps: ReaderLeaseDeps;
  private cache: { root: string; record: LeaseRecord | null } | null = null;

  constructor(deps: ReaderLeaseDeps) {
    this.deps = deps;
  }

  /** The lease in the Brain's repository at `root`, as last fetched or written. */
  known(root: string): LeaseRecord | null {
    if (this.cache?.root !== root) this.cache = { root, record: this.ref(root).read()?.record ?? null };
    return this.cache.record;
  }

  /**
   * Renew the lease, or take it, when the rules say so (`leaseToWrite`). Runs
   * after a check fetched the remote, so it starts from the remote's lease.
   */
  async renew(root: string, remote: string): Promise<void> {
    const ref = this.ref(root);
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
      const stored = ref.read();
      this.remember(root, stored?.record ?? null);
      const me = this.deps.machine();
      const now = this.deps.clock.now();
      const next = leaseToWrite(stored?.record ?? null, { me: { id: me.id, name: me.name }, preferredReader: this.deps.preferredReader(root), standIn: this.deps.standIn(root), founder: this.deps.founder(root), now, lastRefreshAt: this.deps.lastRefreshAt() });
      if (!next) return;
      if (await ref.write(remote, next, stored, authorEnv(me, now))) {
        this.remember(root, next);
        return;
      }
      await ref.fetch(remote);
    }
    this.deps.log.warn("another Machine kept writing the Reader lease; trying again at the next check", { attempts: WRITE_ATTEMPTS });
  }

  /** Forget what was heard, e.g. when Replication is switched off. */
  forget(): void {
    if (!this.cache) return;
    this.cache = null;
    this.deps.onChange();
  }

  private remember(root: string, record: LeaseRecord | null): void {
    const before = this.cache?.root === root ? this.cache.record : undefined;
    this.cache = { root, record };
    if (JSON.stringify(before) !== JSON.stringify(record)) this.deps.onChange();
  }

  private ref(root: string): LeaseRef {
    return new LeaseRef(new Git({ cwd: root }), this.deps.credentials, this.deps.generationCommits);
  }
}
