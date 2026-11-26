/**
 * Watching for what the installer of an Update did (spec #130, "Updater"): the installer writes its outcome into the
 * Machine's state (`install-records.ts`), and whichever service runs then reads it, at its start and every second
 * while only the request is there. An outcome is read into the last Update; a version that failed on this Machine
 * (rolled back, or never switched to) is marked bad (`bad-versions.ts`), so no check offers it again; a rollback raises
 * its one system notification (`rollback-notice.ts`); and the staged release is done with. An installer that has not
 * said anything after 15 minutes is recorded as failed.
 */
import type { LastUpdateView } from "@attache/contracts";
import type { Logger } from "../core/log.ts";
import type { Clock, TimerHandle } from "../replication/clock.ts";
import { markVersionBad } from "./bad-versions.ts";
import { lastUpdateOf, readInstallRequest, readOutcome, recordOutcome, type OutcomeRecord } from "./install-records.ts";
import { notifyRollbackOnce, type Notify } from "./rollback-notice.ts";
import { clearStaging } from "./staging.ts";

/** How often a service waiting for the installer's outcome looks for it. */
const OUTCOME_POLL_MS = 1_000;
/** How long an installer may take before the service stops waiting and says it never reported back. */
const OUTCOME_WAIT_MS = 15 * 60_000;

export interface OutcomeWatchDeps {
  stateDir: string;
  log: Logger;
  clock: Clock;
  /** Raises a desktop notification, for a rolled-back Update. */
  notify: Notify;
  /** The installer said what it did. `bad` is the version that failed on this Machine, or null after a successful Update. */
  settled: (outcome: { lastUpdate: LastUpdateView; bad: string | null }) => void;
  /** The installer is still at work: only its request is there. */
  installing: () => void;
}

export class OutcomeWatch {
  private readonly deps: OutcomeWatchDeps;
  private timer: TimerHandle | null = null;

  constructor(deps: OutcomeWatchDeps) {
    this.deps = deps;
  }

  /**
   * Read the installer's records. With an outcome, the last Update is known and its staged release is done with;
   * with only a request, the installer is still at work, so keep looking until it says or takes too long.
   */
  settle(): void {
    const request = readInstallRequest(this.deps.stateDir);
    const outcome = readOutcome(this.deps.stateDir);
    if (outcome) {
      // Marking is idempotent, so every start does it: one that stopped right after reading the outcome still marks it.
      const bad = outcome.outcome === "updated" ? null : this.markBad(outcome);
      notifyRollbackOnce({ stateDir: this.deps.stateDir, notify: this.deps.notify, log: this.deps.log, now: this.deps.clock.now() }, outcome);
      this.clearStaged();
      this.deps.settled({ lastUpdate: lastUpdateOf(outcome, request), bad });
      return;
    }
    if (!request) return;
    const waited = this.deps.clock.now().getTime() - Date.parse(request.at);
    if (!(waited < OUTCOME_WAIT_MS)) {
      // The installer never said: it was stopped, or it could not run its own runtime. Say so, once, for good.
      recordOutcome(this.deps.stateDir, { outcome: "failed", from: request.from, to: request.to, at: this.deps.clock.now().toISOString(), reason: `The installer for Attache ${request.to} did not report back within ${OUTCOME_WAIT_MS / 60_000} minutes. Look in the logs folder in the Machine's state for the installer's log.` });
      return this.settle();
    }
    this.deps.installing();
    this.watch();
  }

  /** Look for the outcome every second until it is there; a watch already running goes on. */
  watch(): void {
    if (this.timer) return;
    this.timer = this.deps.clock.setTimeout(() => {
      this.timer = null;
      try {
        this.settle();
      } catch (e) {
        this.deps.log.warn("could not read the outcome of the Update", { error: (e as Error).message });
        this.watch();
      }
    }, OUTCOME_POLL_MS);
  }

  stop(): void {
    if (this.timer) this.deps.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  /** Never try the version that failed on this Machine again here, while a newer release still is. */
  private markBad(outcome: OutcomeRecord): string {
    const at = Number.isNaN(Date.parse(outcome.at)) ? this.deps.clock.now() : new Date(outcome.at);
    markVersionBad(this.deps.stateDir, { version: outcome.to, reason: outcome.reason ?? "The installer gave no reason.", at });
    return outcome.to;
  }

  private clearStaged(): void {
    try {
      const left = clearStaging(this.deps.stateDir);
      if (left.length) this.deps.log.info("a staged release is still in use; it is removed with the next Update", { left });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.deps.log.warn("could not clear the staged release", { error: (e as Error).message });
    }
  }
}
