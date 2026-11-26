/**
 * The Updater (spec #130, "Updater"): the deep module behind Updates. It owns
 * the whole lifecycle behind a small interface: the status (`view`), Check now
 * (`check`), Install now and Restart now (`install`), this Machine's settings
 * (`setSettings`), and `start`/`stop` with the service.
 *
 * Installing (#137): `install()` checks, downloads this computer's archive into
 * the staging folder and checks it against the signed manifest (`staging.ts`),
 * records the request (`install-records.ts`) and hands the release to the
 * installer runner (`installer-runner.ts`). The installer stops this service,
 * switches versions and writes its outcome; whichever service runs then (the
 * new version, or this one when the installer changed nothing or switched
 * back) watches for that outcome and shows it as `lastUpdate`.
 *
 * Automatic updates (#139): with the service, unless the mode is Off, the
 * Updater checks at once and every 6 hours after (`scheduleCheck`), on the
 * App's clock. A check that is not report-only goes on by mode (`proceed`):
 * Ask first downloads and verifies, then waits at `ready` for Install now;
 * Automatic does the same, then installs once no Job is running
 * (`job-wait.ts`), or after waiting 24 hours. Install now and Restart now
 * install the verified Update at once; Jobs left running resume from their
 * checkpoint when the service starts again. Off makes no request at all, not
 * even for Check now or Install now. Whatever downloads or installs runs one
 * step at a time (`serial`), so a timer, Check now and Install now never
 * download twice or start two installers.
 *
 * A rolled-back Update (#138): `settle()` marks the version the installer switched back from bad
 * (`bad-versions.ts`), so a check never offers it again; `lastUpdate` says what became of the database.
 * It also raises the one system notification an Update raises (#141, `rollback-notice.ts`), once per outcome.
 */
import type { LastUpdateView, UpdateChannel, UpdateMode, UpdateSettings, UpdatesStatus, UpdatesView } from "@attache/contracts";
import type { Logger } from "../core/log.ts";
import { ReleaseRefusedError } from "../release/verify-release.ts";
import type { Clock, TimerHandle } from "../replication/clock.ts";
import { badVersions, markVersionBad } from "./bad-versions.ts";
import { findUpdate, unreachable, UpdateCheckError, type FoundUpdate } from "./find-update.ts";
import { forgetInstallRequest, lastUpdateOf, readInstallRequest, readOutcome, recordInstallRequest, recordOutcome, type OutcomeRecord } from "./install-records.ts";
import type { InstallerRunner } from "./installer-runner.ts";
import { JobWait, type RunningJobs } from "./job-wait.ts";
import { notifyRollbackOnce, type Notify } from "./rollback-notice.ts";
import type { ReleaseFeed } from "./release-feed.ts";
import type { ReleaseInstall } from "./release-install.ts";
import { clearStaging, stageUpdate, type StagedUpdate } from "./staging.ts";

/** How often a service waiting for the installer's outcome looks for it. */
const OUTCOME_POLL_MS = 1_000;
/** How long an installer may take before the service stops waiting and says it never reported back. */
const OUTCOME_WAIT_MS = 15 * 60_000;
/** How often a Machine looks for an Update, after the check when the service starts. */
export const CHECK_EVERY_MS = 6 * 60 * 60_000;

export interface UpdaterDeps {
  /** The version this Machine runs. */
  version: string;
  stateDir: string;
  log: Logger;
  clock: Clock;
  /** This Machine's Updates settings, kept in its configuration. */
  settings: { get(): UpdateSettings; set(next: UpdateSettings): void };
  /** Something in `view()` changed. */
  changed: () => void;
  feed: ReleaseFeed;
  /** The release install this copy runs from; null for a source checkout, which never updates itself. */
  install: ReleaseInstall | null;
  /** This computer's release target; null when Attache has no release for it. */
  target: string | null;
  /** The keys a release manifest's signature may come from (`release/trusted-keys.ts`). */
  trustedKeys: () => readonly string[];
  /** Starts the staged release's installer. */
  runner: InstallerRunner;
  /** The port the service answers on; null before it listens. */
  port: () => number | null;
  /** The Jobs an Automatic install waits for. */
  jobs: RunningJobs;
  /** Raises a desktop notification, for a rolled-back Update. */
  notify: Notify;
}

export interface CheckOptions {
  /** Only find out what is available: download and install nothing, whatever the mode. Without it, the check goes on as Automatic updates says. */
  reportOnly?: boolean;
}

export class Updater {
  private readonly deps: UpdaterDeps;
  private status: UpdatesStatus = "not_checked";
  private reason: string | null = null;
  private found: FoundUpdate | null = null;
  private lastCheckedAt: string | null = null;
  private lastUpdate: LastUpdateView | null = null;
  /** The verified release in the staging folder, ready for the installer. */
  private staged: StagedUpdate | null = null;
  /** The Jobs an Automatic install waits for, while `waiting_for_jobs`. */
  private jobWait: JobWait | null = null;
  private jobsRunning: number | null = null;
  private running: Promise<void> | null = null;
  /** The last of the steps that download or install, which run one at a time. */
  private tail: Promise<void> | null = null;
  private watch: TimerHandle | null = null;
  private nextCheck: TimerHandle | null = null;
  private stopped = false;
  /** Rises when the settings change, so a check that started before answers for the old channel and is dropped. */
  private generation = 0;

  constructor(deps: UpdaterDeps) {
    this.deps = deps;
  }

  /** Why this copy cannot update itself, or null when it can. Asked every time: a build's key and its install do not change, but tests play both. */
  private unavailable(): string | null {
    if (!this.deps.install) return "Attache runs from a source checkout here, so it does not update itself. Pull the newest code and build it instead.";
    if (!this.deps.target) return `There is no Attache release for ${process.platform}/${process.arch}, so this Machine cannot update itself.`;
    if (!this.deps.trustedKeys().length) return "This copy of Attache holds no release key, so it cannot check an Update. Install a release from GitHub by hand.";
    return null;
  }

  view(): UpdatesView {
    const { channel, mode } = this.deps.settings.get();
    const unavailable = this.unavailable();
    // Off hides what an earlier check found: nothing more happens with it. An installer already running still restarts the service.
    const off = mode === "off" && this.status !== "installing";
    const m = this.found?.manifest;
    return {
      version: this.deps.version,
      channel,
      mode,
      status: unavailable ? "unavailable" : off ? "off" : this.status,
      reason: unavailable ?? (off ? null : this.reason),
      update: unavailable || off || !m ? null : { version: m.version, channel: m.channel, publishedAt: m.publishedAt, notes: m.notes },
      jobs: !unavailable && !off && this.status === "waiting_for_jobs" ? this.jobsRunning : null,
      lastCheckedAt: this.lastCheckedAt,
      lastUpdate: this.lastUpdate,
    };
  }

  /** With the service: read what the last Update did, keep watching while its installer has yet to say, and check at once unless Off. */
  start(): void {
    this.stopped = false;
    this.settle();
    this.scheduleCheck(0);
  }

  /**
   * Something waits for an Update (a Replication paused on a newer Brain format, #143): check at once, then every
   * 6 hours again, going on as the mode says. Nothing while Off, unavailable or stopped: Off makes no request.
   */
  checkSoon(): void {
    this.scheduleCheck(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.watch) this.deps.clock.clearTimeout(this.watch);
    this.watch = null;
    this.cancelCheck();
    this.endJobWait();
  }

  /**
   * Check now: look for an Update and answer with the status after it. A report-only check already running is joined, not repeated.
   * Without `reportOnly` the check goes on as the mode says, as the check every 6 hours does. Off answers `off` and asks nothing.
   */
  async check(options: CheckOptions = {}): Promise<UpdatesView> {
    if (this.unavailable() || this.mode() === "off") return this.view();
    if (!options.reportOnly) {
      await this.serial(() => this.checkAndProceed());
      return this.view();
    }
    if (this.busy()) return this.view();
    if (!this.running) {
      const run = this.runCheck().finally(() => {
        if (this.running === run) this.running = null;
      });
      this.running = run;
    }
    await this.running;
    return this.view();
  }

  /**
   * Install now, and Restart now while waiting for Jobs: install the Update at once, whatever Jobs run; they resume after the restart.
   * A verified Update (`ready`, `waiting_for_jobs`) goes straight to the installer; otherwise this checks, downloads and verifies first.
   * Answers once the installer runs (`installing`), or with why nothing was installed. A request while one runs gets `installing`.
   */
  install(): Promise<UpdatesView> {
    if (this.unavailable() || this.mode() === "off") return Promise.resolve(this.view());
    return this.serial(async () => {
      if (this.status === "installing") return this.view();
      if (!(this.status === "ready" || this.status === "waiting_for_jobs") || !this.verified()) {
        await this.check({ reportOnly: true });
        const found = this.found;
        if (!(this.status === "available" || this.status === "ready") || !found) return this.view();
        if (!this.verified() && !(await this.download(found))) return this.view();
      }
      this.endJobWait();
      await this.apply();
      return this.view();
    });
  }

  /**
   * Change this Machine's Updates settings. A new channel forgets what the old one found; turning Off stops every timer;
   * a new channel, or turning Updates back on, checks at once. Changing between Automatic and Ask first acts on a verified Update as the new mode says.
   * While the installer runs, the settings are kept for the version it starts.
   */
  setSettings(input: { channel?: UpdateChannel | undefined; mode?: UpdateMode | undefined }): UpdatesView {
    const current = this.deps.settings.get();
    const next: UpdateSettings = { ...current, ...(input.channel ? { channel: input.channel } : {}), ...(input.mode ? { mode: input.mode } : {}) };
    const channelChanged = next.channel !== current.channel;
    if (!channelChanged && next.mode === current.mode) return this.view();
    this.deps.settings.set(next);
    this.generation++;
    if (this.status === "installing") {
      this.deps.changed();
      return this.view();
    }
    this.endJobWait();
    if (channelChanged) {
      this.running = null;
      this.status = "not_checked";
      this.reason = null;
      this.found = null;
    } else if (this.status === "ready" || this.status === "waiting_for_jobs") {
      this.status = "available";
    }
    this.deps.changed();
    if (next.mode === "off") this.cancelCheck();
    else if (channelChanged || current.mode === "off") this.scheduleCheck(0);
    else void this.serial(() => this.safely(() => this.proceed()));
    return this.view();
  }

  private mode(): UpdateMode {
    return this.deps.settings.get().mode;
  }

  /** Whether an Update is downloading, waiting for Jobs or installing: a check or a channel change must not cut in. */
  private busy(): boolean {
    return this.status === "downloading" || this.status === "waiting_for_jobs" || this.status === "installing";
  }

  /** Whether the Update found is the one verified in the staging folder. */
  private verified(): boolean {
    return !!this.found && this.staged?.manifest.version === this.found.manifest.version;
  }

  /** What a found Update shows while nothing happens with it: `ready` once Ask first has it verified. */
  private resting(): UpdatesStatus {
    if (!this.found) return "not_checked";
    return this.verified() && this.mode() === "ask_first" ? "ready" : "available";
  }

  /**
   * Run the steps that download or install one at a time: each starts once the one before has finished.
   * With nothing running, `step` starts at once, so its first status change shows in the answer to the request that asked for it.
   */
  private serial<T>(step: () => Promise<T>): Promise<T> {
    const result = this.tail ? this.tail.then(step) : step();
    const tail: Promise<void> = result.then(
      () => undefined,
      // Each step answers its own caller; a failed step must not stop the ones after it.
      () => undefined,
    );
    this.tail = tail;
    void tail.then(() => {
      if (this.tail === tail) this.tail = null;
    });
    return result;
  }

  /** Check in `ms`, then every 6 hours after; nothing while Off, unavailable or stopped. */
  private scheduleCheck(ms: number): void {
    this.cancelCheck();
    if (this.stopped || this.unavailable() || this.mode() === "off") return;
    this.nextCheck = this.deps.clock.setTimeout(() => {
      this.nextCheck = null;
      return this.serial(() => this.checkAndProceed()).finally(() => {
        if (!this.nextCheck) this.scheduleCheck(CHECK_EVERY_MS);
      });
    }, ms);
  }

  private cancelCheck(): void {
    if (this.nextCheck) this.deps.clock.clearTimeout(this.nextCheck);
    this.nextCheck = null;
  }

  /** A check that goes on as the mode says. While an Update waits for Jobs or installs, there is nothing to look for. */
  private checkAndProceed(): Promise<void> {
    return this.safely(async () => {
      if (this.busy()) return;
      const generation = this.generation;
      await this.check({ reportOnly: true });
      if (generation === this.generation) await this.proceed();
    });
  }

  /** Run a step no request waits for: one that throws (the Machine's state could not be written) is logged, and the next check tries again. */
  private async safely(step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (e) {
      this.deps.log.warn("the Update did not go on", { error: (e as Error).message });
    }
  }

  /** Take a found Update as far as the mode says: Ask first to `ready`, Automatic on to the installer once no Job runs. */
  private async proceed(): Promise<void> {
    const found = this.found;
    if (this.mode() === "off" || !found || !(this.status === "available" || this.status === "ready")) return;
    if (!this.verified()) {
      const generation = this.generation;
      if (!(await this.download(found))) return;
      // The settings changed during the download: what to do now is for the new settings, through the step they queued.
      if (generation !== this.generation) return this.set(this.resting());
    }
    if (this.mode() === "ask_first") return this.set("ready");
    const running = this.deps.jobs.count();
    if (running === 0) return this.apply();
    this.jobsRunning = running;
    this.jobWait = new JobWait(
      {
        clock: this.deps.clock,
        jobs: this.deps.jobs,
        onCount: (count) => {
          this.jobsRunning = count;
          this.set("waiting_for_jobs");
        },
        onClear: () =>
          this.serial(() =>
            this.safely(async () => {
              this.jobWait = null;
              // Restart now or a change of settings came first.
              if (this.status === "waiting_for_jobs" && this.verified()) await this.apply();
            }),
          ),
      },
      running,
    );
    this.deps.log.info("an Update waits for running Jobs to finish", { version: found.manifest.version, jobs: running });
    this.set("waiting_for_jobs");
  }

  private endJobWait(): void {
    this.jobWait?.cancel();
    this.jobWait = null;
    this.jobsRunning = null;
  }

  /** Download the found Update's archive for this computer and verify it; false, with the reason shown, when that failed. */
  private async download(found: FoundUpdate): Promise<boolean> {
    const to = found.manifest.version;
    this.set("downloading");
    try {
      this.staged = await stageUpdate({ feed: this.deps.feed, found, target: this.deps.target!, stateDir: this.deps.stateDir, trustedKeys: this.deps.trustedKeys() });
      return true;
    } catch (e) {
      this.staged = null;
      const reason = e instanceof ReleaseRefusedError ? `The Update to Attache ${to} was refused: ${e.message}` : `The download of Attache ${to} failed. ${unreachable(this.deps.feed, e).message}`;
      this.deps.log.warn("the Update was not installed", { version: to, reason });
      this.set("check_failed", reason);
      return false;
    }
  }

  private set(status: UpdatesStatus, reason: string | null = null): void {
    this.status = status;
    this.reason = reason;
    this.deps.changed();
  }

  private async runCheck(): Promise<void> {
    const generation = this.generation;
    this.set("checking");
    let outcome: { status: UpdatesStatus; reason: string | null; found: FoundUpdate | null };
    try {
      const found = await findUpdate({
        feed: this.deps.feed,
        installed: this.deps.version,
        channel: this.deps.settings.get().channel,
        bad: badVersions(this.deps.stateDir).map((b) => b.version),
        trustedKeys: this.deps.trustedKeys(),
        target: this.deps.target!,
        refused: (version, reason) => this.deps.log.warn("a newer release was refused", { version, reason }),
      });
      outcome = found ? { status: "available", reason: null, found } : { status: "up_to_date", reason: null, found: null };
    } catch (e) {
      const reason = e instanceof UpdateCheckError ? e.message : `The check for an Update failed: ${(e as Error).message}`;
      this.deps.log.warn("the check for an Update failed", { reason, error: (e as Error).message });
      // What an earlier check found and verified stays true; only this check failed.
      outcome = { status: "check_failed", reason, found: this.found };
    }
    if (generation !== this.generation) return;
    this.found = outcome.found;
    this.lastCheckedAt = this.deps.clock.now().toISOString();
    // An Update already verified for Ask first stays ready when a check finds it again.
    this.set(outcome.status === "available" ? this.resting() : outcome.status, outcome.reason);
  }

  /** Hand the verified Update to the installer runner, which restarts the service on it. */
  private async apply(): Promise<void> {
    const staged = this.staged;
    if (this.status === "installing" || !staged) return;
    const to = staged.manifest.version;
    const port = this.deps.port();
    if (port === null) {
      this.set("check_failed", `The Update to Attache ${to} cannot start before the service answers on its port. Try again in a moment.`);
      return;
    }
    this.endJobWait();
    recordInstallRequest(this.deps.stateDir, { from: this.deps.version, to, notes: staged.manifest.notes, at: this.deps.clock.now().toISOString() });
    this.set("installing");
    try {
      await this.deps.runner.start({ from: this.deps.version, version: to, release: staged.folder, archive: staged.archive, prefix: this.deps.install!.prefix, stateDir: this.deps.stateDir, port });
    } catch (e) {
      forgetInstallRequest(this.deps.stateDir);
      const reason = `Attache could not start the installer for ${to}, so nothing was changed: ${(e as Error).message}`;
      this.deps.log.warn("the installer did not start", { version: to, error: (e as Error).message });
      this.set("check_failed", reason);
      return;
    }
    this.deps.log.info("the installer for an Update started; it restarts the service", { from: this.deps.version, to });
    this.watchForOutcome();
  }

  /**
   * Read the installer's records. With an outcome, the last Update is known and its staged release is done with;
   * with only a request, the installer is still at work, so keep looking until it says or takes too long.
   */
  private settle(): void {
    const request = readInstallRequest(this.deps.stateDir);
    const outcome = readOutcome(this.deps.stateDir);
    if (outcome) {
      this.lastUpdate = lastUpdateOf(outcome, request);
      // A version the installer switched back from is never tried again here, while a newer release still is.
      // Marking is idempotent, so every start does it: one that stopped right after reading the outcome still marks it.
      if (outcome.outcome === "rolled_back") this.markBad(outcome);
      notifyRollbackOnce({ stateDir: this.deps.stateDir, notify: this.deps.notify, log: this.deps.log, now: this.deps.clock.now() }, outcome);
      this.clearStaged();
      if (this.status !== "installing") return;
      this.set(this.resting());
      // After a rollback, what this Machine may take changed, and its check at start was skipped while it waited: look again now.
      if (outcome.outcome === "rolled_back") this.scheduleCheck(0);
      return;
    }
    if (!request) return;
    const waited = this.deps.clock.now().getTime() - Date.parse(request.at);
    if (!(waited < OUTCOME_WAIT_MS)) {
      // The installer never said: it was stopped, or it could not run its own runtime. Say so, once, for good.
      recordOutcome(this.deps.stateDir, { outcome: "failed", from: request.from, to: request.to, at: this.deps.clock.now().toISOString(), reason: `The installer for Attache ${request.to} did not report back within ${OUTCOME_WAIT_MS / 60_000} minutes. Look in the logs folder in the Machine's state for the installer's log.` });
      return this.settle();
    }
    if (this.status !== "installing") this.set("installing");
    this.watchForOutcome();
  }

  /** Mark the version a rollback switched back from bad, and forget it as the Update found, so nothing offers it. */
  private markBad(outcome: OutcomeRecord): void {
    const at = Number.isNaN(Date.parse(outcome.at)) ? this.deps.clock.now() : new Date(outcome.at);
    markVersionBad(this.deps.stateDir, { version: outcome.to, reason: outcome.reason ?? "The installer gave no reason.", at });
    if (this.found?.manifest.version === outcome.to) this.found = null;
    if (this.staged?.manifest.version === outcome.to) this.staged = null;
  }

  private watchForOutcome(): void {
    if (this.watch) return;
    this.watch = this.deps.clock.setTimeout(() => {
      this.watch = null;
      try {
        this.settle();
      } catch (e) {
        this.deps.log.warn("could not read the outcome of the Update", { error: (e as Error).message });
        this.watchForOutcome();
      }
    }, OUTCOME_POLL_MS);
  }

  private clearStaged(): void {
    this.staged = null;
    try {
      const left = clearStaging(this.deps.stateDir);
      if (left.length) this.deps.log.info("a staged release is still in use; it is removed with the next Update", { left });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.deps.log.warn("could not clear the staged release", { error: (e as Error).message });
    }
  }
}
