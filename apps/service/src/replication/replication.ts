import type { ReplicationView } from "@attache/contracts";
import type { Logger } from "../core/log.ts";
import type { Db } from "../core/db.ts";
import type { MachineIdentity } from "../core/machine.ts";
import type { MemoryChange } from "../memory/store.ts";
import type { Clock, TimerHandle } from "./clock.ts";
import { Git, GitError, gitVersion } from "./git.ts";
import { gitMissingMessage } from "../platform/git-install.ts";
import { authorEnv, BrainRepo } from "./brain-repo.ts";
import { commitMessage, machineTrailer } from "./commit-message.ts";
import { cloneBrain, isEmptyFolder, notEmptyRefusal, prepareRepository, refusalOf, remoteFailure, remoteHasBrain, ReplicationSetupError, setupRemote, sharesHistoryWith } from "./setup.ts";
import { ReplicationSettingsStore, type ReplicationSettings } from "./settings.ts";
import { ReplicatedMachines } from "./machines.ts";
import { isMachineRecordPath, MachineRecords } from "./machine-records.ts";
import { ReaderLease } from "./reader-lease.ts";
import type { LeaseRecord } from "../reader/lease.ts";
import type { MergeNotice, RemoteVerdict, ReplicationSeams } from "./seams.ts";

/** A save is committed and pushed this long after the last write, so a burst of writes makes one commit. */
export const COMMIT_DELAY_MS = 30_000;
/** How often the remote is checked for other Machines' changes. */
export const CHECK_EVERY_MS = 60_000;
/** Fetch, merge and push again this many times when another Machine pushed first. */
const PUSH_ATTEMPTS = 5;
const RETRY_BASE_MS = 5_000;
/** How long stopping the service waits for a check that is talking to the remote. */
const STOP_WAIT_MS = 5_000;

export interface ReplicationDeps {
  db: Db;
  log: Logger;
  clock: Clock;
  seams: ReplicationSeams;
  machine: () => MachineIdentity;
  /** The Attache version this Machine runs, which its Machine record carries. */
  version: string;
  /** The data folder that is open now, if any. */
  dataRoot: () => string | null;
  /** Change-log entries after `seq`, to describe a commit. */
  changesAfter: (seq: number) => MemoryChange[];
  /** The newest change-log entry's `seq`, 0 when there is none. */
  latestSeq: () => number;
  /** Called whenever the status may have changed. */
  onChange?: () => void;
  /** Back up a folder a join refused, so the Brain in it is safe; returns the archive's path. */
  backUpFolder: (folder: string) => Promise<string>;
  /** This Machine's last Source refresh of every source, which the Reader lease carries to the others. */
  lastSourceRefresh?: () => string | null;
  /** Whether this Machine has a source of its own connected, besides the data folder: without one it never takes a silent Reader's place. */
  sourcesConnected?: () => boolean;
  /** The Reader lease as this Machine knows it changed. */
  onLeaseChange?: () => void;
  /** Lease commits per generation of the Reader lease (`LEASE_GENERATION_COMMITS` by default). */
  leaseGenerationCommits?: number;
}

type Outcome = { status: ReplicationSettings["status"]; cause: string | null; pushed?: boolean };

const OFF: ReplicationView = Object.freeze({ status: "off", remote: null, cause: null, lastCheckedAt: null, lastPushedAt: null, upToDateAt: null });

/**
 * Keeps this Machine's copy of the Brain the same as the others through a git
 * remote: commit, fetch, merge, push. It merges and fast-forwards only; it
 * never rebases or force-pushes. A failure is reported in the status and
 * retried; it never reaches the save that triggered it.
 */
export class Replication {
  readonly settings: ReplicationSettingsStore;
  /** The Machines sharing the Brain, standby flags and the Preferred Reader, as recorded in the Brain. */
  readonly machines: ReplicatedMachines;
  /** Which Machine is the Reader, shared through the repository outside the Brain's history. */
  private readonly lease: ReaderLease;
  private readonly deps: ReplicationDeps;
  private started = false;
  /** Wall-clock time the service started, compared with lock files' times (not the Clock, which drives timers). */
  private startedAtMs = Date.now();
  private busy = false;
  private commitTimer: TimerHandle | null = null;
  private checkTimer: TimerHandle | null = null;
  private soonTimer: TimerHandle | null = null;
  private retryTimer: TimerHandle | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private failures = 0;
  private readonly pulledListeners = new Set<(paths: readonly string[]) => void>();
  private readonly noticeListeners = new Set<(notices: readonly MergeNotice[]) => void>();

  constructor(deps: ReplicationDeps) {
    this.deps = deps;
    this.settings = new ReplicationSettingsStore(deps.db);
    this.lease = new ReaderLease({
      log: deps.log,
      clock: deps.clock,
      machine: deps.machine,
      credentials: deps.seams.credentials,
      preferredReader: (root) => new MachineRecords(root).preferredReader(),
      standIn: (root) => new MachineRecords(root).machine(deps.machine().id)?.standby === true && (deps.sourcesConnected?.() ?? false),
      founder: (root) => this.repo(root).foundedBy() === deps.machine().id,
      lastRefreshAt: () => deps.lastSourceRefresh?.() ?? null,
      onChange: () => deps.onLeaseChange?.(),
      ...(deps.leaseGenerationCommits ? { generationCommits: deps.leaseGenerationCommits } : {}),
    });
    this.machines = new ReplicatedMachines({
      root: () => this.activeRoot(),
      machine: deps.machine,
      version: deps.version,
      clock: deps.clock,
      lastChangeBy: (root, id) => this.repo(root).lastChangeBy(id),
      written: () => {
        this.noteWrite();
        this.deps.onChange?.();
      },
    });
  }

  /** The data folder Replication is on for, unless it is off or the data folder moved. */
  private activeRoot(): string | null {
    const s = this.settings.get();
    return s && !this.folderMoved(s) ? s.dataFolder : null;
  }

  /** This Machine was renamed: its record in the Brain says the new name from the next commit on. */
  machineRenamed(): void {
    this.machines.recordThisMachine();
  }

  // ---- what other parts of the service plug in ------------------------------

  /** Files a merge or fast-forward changed in the data folder, right after git wrote them. */
  onPulled(listener: (paths: readonly string[]) => void): () => void {
    this.pulledListeners.add(listener);
    return () => this.pulledListeners.delete(listener);
  }

  /** What the merge rules want the owner to look at. */
  onMergeNotice(listener: (notices: readonly MergeNotice[]) => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  view(): ReplicationView {
    const s = this.settings.get();
    if (!s) return OFF;
    const moved = this.folderMoved(s);
    return { status: moved ? "blocked" : s.status, remote: s.remote, cause: moved ?? s.cause, lastCheckedAt: s.checkedAt, lastPushedAt: s.pushedAt, upToDateAt: s.upToDateAt };
  }

  /** The Reader lease as this Machine last heard it; null while Replication is off or no Machine holds it yet. */
  readerLease(): LeaseRecord | null {
    const root = this.activeRoot();
    return root ? this.lease.known(root) : null;
  }

  /** A Machine's name as its record in the Brain says; null while Replication is off or it has no record. */
  recordedName(id: string): string | null {
    const root = this.activeRoot();
    return root ? (new MachineRecords(root).machine(id)?.name ?? null) : null;
  }

  /** A Source refresh of every source finished: the lease tells the other Machines at the next check, which is now. */
  noteSourceRefresh(): void {
    if (this.started && this.settings.get()) this.soon();
  }

  /** A lease that cannot be written now is written at a later check; the Brain's own Replication is not held up by it. */
  private async renewLease(root: string, remote: string): Promise<void> {
    try {
      await this.lease.renew(root, remote);
    } catch (e) {
      this.deps.log.warn("could not renew the Reader lease; trying again at the next check", { error: e instanceof GitError ? e.cause : (e as Error).message });
    }
  }

  // ---- triggers ---------------------------------------------------------------

  start(): void {
    this.started = true;
    this.startedAtMs = Date.now();
    if (!this.settings.get()) return;
    this.machines.recordThisMachine();
    this.soon();
    this.arm();
  }

  /** Stop the timers and let a running check finish, without waiting long on a remote that does not answer. */
  async stop(): Promise<void> {
    this.started = false;
    this.clearTimers();
    if (!this.running) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.running, new Promise<void>((done) => (timer = setTimeout(done, STOP_WAIT_MS)).unref())]);
    clearTimeout(timer);
  }

  private clearTimers(): void {
    for (const t of [this.commitTimer, this.checkTimer, this.soonTimer, this.retryTimer]) if (t) this.deps.clock.clearTimeout(t);
    this.commitTimer = this.checkTimer = this.soonTimer = this.retryTimer = null;
  }

  /** The service wrote to the Brain: commit and push once writes have been quiet for a while. */
  noteWrite(): void {
    if (!this.started || !this.settings.get()) return;
    if (this.commitTimer) this.deps.clock.clearTimeout(this.commitTimer);
    this.commitTimer = this.deps.clock.setTimeout(() => {
      this.commitTimer = null;
      return this.cycle();
    }, COMMIT_DELAY_MS);
  }

  /** Someone edited the Brain outside the service, or the Machine woke up: check now. */
  noteOutsideEdit(): void {
    if (this.started && this.settings.get()) this.soon();
  }

  wake(): void {
    this.noteOutsideEdit();
  }

  /** Commit, fetch, merge and push now. */
  async check(): Promise<ReplicationView> {
    await this.cycle();
    return this.view();
  }

  private soon(): void {
    if (this.soonTimer) return;
    this.soonTimer = this.deps.clock.setTimeout(() => {
      this.soonTimer = null;
      return this.cycle();
    }, 0);
  }

  /** The one-minute check of the remote, kept running while Replication is on. */
  private arm(): void {
    if (!this.started || this.checkTimer || !this.settings.get()) return;
    this.checkTimer = this.deps.clock.setTimeout(() => {
      this.checkTimer = null;
      this.arm();
      return this.cycle();
    }, CHECK_EVERY_MS);
  }

  private retryLater(): void {
    if (!this.started || this.retryTimer) return;
    this.failures++;
    const delay = Math.min(CHECK_EVERY_MS, RETRY_BASE_MS * 2 ** (this.failures - 1));
    this.retryTimer = this.deps.clock.setTimeout(() => {
      this.retryTimer = null;
      return this.cycle();
    }, delay);
  }

  // ---- the loop ---------------------------------------------------------------

  /** One check at a time; a check asked for while one runs makes it run once more. */
  private cycle(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.rerun = false;
          try {
            await this.runOnce();
          } catch (e) {
            // Only reachable when the service stopped mid-check (its database is closed); nothing is lost.
            this.deps.log.warn("replication check stopped", { error: (e as Error).message });
          }
        } while (this.rerun && this.started);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private folderMoved(s: ReplicationSettings): string | null {
    const root = this.deps.dataRoot();
    return root === s.dataFolder ? null : `Replication was set up for ${s.dataFolder}, but the data folder is now ${root ?? "not chosen"}.`;
  }

  private repo(root: string): BrainRepo {
    return new BrainRepo(new Git({ cwd: root }), this.deps.seams);
  }

  private async runOnce(): Promise<void> {
    const s = this.settings.get();
    if (!s || this.folderMoved(s)) return;
    const repo = this.repo(s.dataFolder);
    try {
      const outcome = await this.replicate(repo, s);
      this.report(outcome);
      if (outcome.status === "up_to_date") await this.renewLease(s.dataFolder, s.remote);
    } catch (e) {
      const outcome = failureOutcome(e);
      if (!(e instanceof GitError)) this.deps.log.error("replication check failed", { error: (e as Error).message });
      this.report(outcome);
      this.retryLater();
    }
  }

  private async replicate(repo: BrainRepo, s: ReplicationSettings): Promise<Outcome> {
    this.recoverInterrupted(repo, s.dataFolder);
    // A week-old record is written again here, and committed with this check rather than one more after it.
    if (this.machines.refresh(s.dataFolder)) this.deps.onChange?.();
    const first = this.commitLocal(repo);
    if (first) return first;
    const guard = await this.checkRemote(s.remote);
    if (!guard.ok) return { status: guard.status, cause: guard.cause };
    for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt++) {
      await repo.fetch(s.remote);
      // Saves made while fetching are part of this round too.
      const refused = this.commitLocal(repo);
      if (refused) return refused;
      const merged = repo.mergeFetched(this.machineRef(), this.deps.clock.now());
      if (merged.kind === "blocked") return { status: merged.status, cause: merged.cause };
      if (merged.kind === "retry") {
        this.deps.log.warn("could not merge this time; trying again shortly", { cause: merged.cause });
        this.retryLater();
        return { status: s.status, cause: s.cause };
      }
      if (merged.kind === "merged") this.announce(merged.changed, merged.notices);
      if (repo.ahead() === 0) return this.succeeded(false);
      try {
        await repo.push(s.remote);
        return this.succeeded(true);
      } catch (e) {
        if (!(e instanceof GitError) || e.kind !== "rejected") throw e;
        // Another Machine pushed first: fetch and merge its changes, then push again.
      }
    }
    this.retryLater();
    return { status: s.status, cause: s.cause };
  }

  /**
   * Undo what a crash left halfway: git's stale locks, then a merge in progress.
   * The files the abandoned merge had changed are back as before and are
   * re-indexed; the merge itself runs again in this check.
   */
  private recoverInterrupted(repo: BrainRepo, folder: string): void {
    const locks = repo.removeStaleLocks(this.startedAtMs);
    if (locks.length) this.deps.log.warn("removed git locks left by an interrupted command", { folder, locks });
    const reverted = repo.abortInterruptedMerge();
    if (!reverted) return;
    this.deps.log.warn("abandoned a merge that was interrupted; merging again", { folder });
    if (reverted.length) this.announce(reverted, []);
  }

  private succeeded(pushed: boolean): Outcome {
    this.failures = 0;
    return { status: "up_to_date", cause: null, pushed };
  }

  /** Commit what changed since the last commit. Returns an outcome only when a guard refused. */
  private commitLocal(repo: BrainRepo): Outcome | null {
    const s = this.settings.get()!;
    const machine = this.machineRef();
    const latest = this.deps.latestSeq();
    const changes = this.deps.changesAfter(s.committedSeq).filter((c) => c.seq <= latest);
    const out = repo.commitAll(authorEnv(machine, this.deps.clock.now()), (staged) => commitMessage(machine, staged, changes));
    if (out.kind === "refused") return { status: out.verdict.status, cause: out.verdict.cause };
    this.settings.committed(latest);
    return null;
  }

  private async checkRemote(remote: string): Promise<RemoteVerdict> {
    for (const g of this.deps.seams.remoteGuards) {
      const v = await g.check(remote);
      if (!v.ok) return v;
    }
    return { ok: true };
  }

  private announce(changed: readonly string[], notices: readonly MergeNotice[]): void {
    // Another Machine's name, standby flag or the Preferred Reader changed: the Dashboard lists them.
    if (changed.some(isMachineRecordPath)) this.deps.onChange?.();
    for (const l of this.pulledListeners) {
      try {
        l(changed);
      } catch (e) {
        this.deps.log.error("could not apply files another Machine changed", { error: (e as Error).message });
      }
    }
    if (notices.length) for (const l of this.noticeListeners) l(notices);
  }

  private report(o: Outcome): void {
    const before = this.view();
    this.settings.report({ status: o.status, cause: o.cause, at: this.deps.clock.now().toISOString(), pushed: o.pushed ?? false });
    const after = this.view();
    if (before.status !== after.status || before.cause !== after.cause || o.pushed) this.deps.onChange?.();
  }

  private machineRef() {
    const m = this.deps.machine();
    return { id: m.id, name: m.name };
  }

  // ---- setup and join ---------------------------------------------------------

  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    const current = this.settings.get();
    if (current) throw new ReplicationSetupError(409, "already_set_up", `Replication is already on for this Machine, with ${current.remote}.`);
    if (this.busy) throw new ReplicationSetupError(409, "busy", "Replication is being set up already. Wait for it to finish.");
    if (!gitVersion()) throw new ReplicationSetupError(409, "git_missing", gitMissingMessage());
    this.busy = true;
    try {
      return await run();
    } finally {
      this.busy = false;
    }
  }

  private async refuseRemote(remote: string): Promise<void> {
    const refusal = refusalOf(await this.checkRemote(remote));
    if (refusal) throw refusal;
  }

  /**
   * Switch Replication on with this Machine's Brain: make the data folder a
   * repository, commit it and push it to `remoteInput`, which must not hold a Brain yet.
   */
  setup(remoteInput: string): Promise<ReplicationView> {
    return this.exclusive(async () => {
      const root = this.deps.dataRoot();
      if (!root) throw new ReplicationSetupError(409, "needs_data_folder", "Choose a data folder first.");
      const remote = setupRemote(remoteInput);
      await this.refuseRemote(remote);
      const git = new Git({ cwd: root });
      if (await remoteHasBrain(git, remote, this.deps.seams)) {
        if (!(await sharesHistoryWith(git, remote, this.deps.seams))) throw new ReplicationSetupError(409, "remote_has_brain", "That repository already holds a Brain. Join it from this Machine instead, into an empty folder.");
        return this.resume(git, root, remote);
      }
      prepareRepository(git, remote);
      this.machines.recordThisMachine(root);
      const repo = new BrainRepo(git, this.deps.seams);
      const machine = this.machineRef();
      const latest = this.deps.latestSeq();
      const first = repo.commitAll(authorEnv(machine, this.deps.clock.now()), (staged) => [`${machine.name}: start Replication of the Brain (${staged.length} files)`, "", machineTrailer(machine)].join("\n"));
      if (first.kind === "refused") throw new ReplicationSetupError(409, "commit_refused", first.verdict.cause);
      try {
        await repo.push(remote);
      } catch (e) {
        throw remoteFailure(e, "push the Brain");
      }
      const at = this.deps.clock.now().toISOString();
      this.settings.enable({ dataFolder: root, remote, enabledAt: at, committedSeq: latest, pushedAt: at });
      // The first Machine was its own Reader, and stays the Reader without a gap.
      await this.renewLease(root, remote);
      return this.switchedOn();
    });
  }

  /**
   * Switch Replication on again on a Machine that had it before: this copy and
   * the repository share their history, so the next check merges what changed
   * on either side while it was off, like any other check.
   */
  private async resume(git: Git, root: string, remote: string): Promise<ReplicationView> {
    prepareRepository(git, remote);
    this.machines.recordThisMachine(root);
    const at = this.deps.clock.now().toISOString();
    // Saves made while off are committed by file, as git sees them: the change log has no mark of where Replication stopped.
    this.settings.enable({ dataFolder: root, remote, enabledAt: at, committedSeq: this.deps.latestSeq(), pushedAt: null });
    this.switchedOn();
    await this.cycle();
    return this.view();
  }

  /**
   * Join a Brain another Machine set up: clone it into `target`, which must be
   * empty, then `open` it as this Machine's data folder (which builds the index).
   */
  join(remoteInput: string, target: string, open: (path: string) => void): Promise<ReplicationView> {
    return this.exclusive(async () => {
      const remote = setupRemote(remoteInput);
      if (!isEmptyFolder(target)) throw await notEmptyRefusal(target, this.deps.backUpFolder, this.deps.log);
      await this.refuseRemote(remote);
      await cloneBrain(remote, target, this.deps.seams);
      open(target);
      const at = this.deps.clock.now().toISOString();
      this.settings.enable({ dataFolder: target, remote, enabledAt: at, committedSeq: this.deps.latestSeq(), pushedAt: null });
      const view = this.switchedOn();
      // Sent with the next commit, so the other Machines list this one.
      this.machines.recordThisMachine(target);
      return view;
    });
  }

  /**
   * Switch Replication off on this Machine. The data folder, its notes and its
   * history stay exactly as they are, and saves carry on locally; nothing is
   * sent or fetched until Replication is set up again.
   */
  async switchOff(): Promise<ReplicationView> {
    if (this.busy) throw new ReplicationSetupError(409, "busy", "Replication is being set up. Wait for it to finish.");
    if (!this.settings.get()) return this.view();
    this.clearTimers();
    this.settings.disable();
    this.lease.forget();
    this.failures = 0;
    await this.running;
    this.deps.onChange?.();
    return this.view();
  }

  private switchedOn(): ReplicationView {
    this.failures = 0;
    this.arm();
    this.deps.onChange?.();
    return this.view();
  }
}

function failureOutcome(e: unknown): Outcome {
  if (e instanceof GitError) {
    if (e.kind === "offline") return { status: "offline", cause: e.cause };
    if (e.kind === "unauthorized") return { status: "unauthorized", cause: e.cause };
    return { status: "blocked", cause: e.cause };
  }
  return { status: "blocked", cause: (e as Error).message };
}
