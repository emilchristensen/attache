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
 * Still to come, extending this class rather than adding a second one:
 * - marking a rolled-back version bad (`markVersionBad`) and the notification for it (#138);
 * - Automatic updates' modes, the check at start and every 6 hours, waiting for Jobs, Restart now (#139):
 *   `start()`/`stop()` already run with the service on the App's clock; act on a check only when `reportOnly` is false.
 */
import type { LastUpdateView, UpdateChannel, UpdateSettings, UpdatesStatus, UpdatesView } from "@attache/contracts";
import type { Logger } from "../core/log.ts";
import { ReleaseRefusedError } from "../release/verify-release.ts";
import type { Clock, TimerHandle } from "../replication/clock.ts";
import { badVersions } from "./bad-versions.ts";
import { findUpdate, unreachable, UpdateCheckError, type FoundUpdate } from "./find-update.ts";
import { forgetInstallRequest, lastUpdateOf, readInstallRequest, readOutcome, recordInstallRequest, recordOutcome } from "./install-records.ts";
import type { InstallerRunner } from "./installer-runner.ts";
import type { ReleaseFeed } from "./release-feed.ts";
import type { ReleaseInstall } from "./release-install.ts";
import { clearStaging, stageUpdate } from "./staging.ts";

/** How often a service waiting for the installer's outcome looks for it. */
const OUTCOME_POLL_MS = 1_000;
/** How long an installer may take before the service stops waiting and says it never reported back. */
const OUTCOME_WAIT_MS = 15 * 60_000;

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
}

export interface CheckOptions {
  /** Only find out what is available: download and install nothing, whatever the mode. Automatic updates acts on a check only without it (#139). */
  reportOnly?: boolean;
}

export class Updater {
  private readonly deps: UpdaterDeps;
  private status: UpdatesStatus = "not_checked";
  private reason: string | null = null;
  private found: FoundUpdate | null = null;
  private lastCheckedAt: string | null = null;
  private lastUpdate: LastUpdateView | null = null;
  private running: Promise<void> | null = null;
  private installing: Promise<UpdatesView> | null = null;
  private watch: TimerHandle | null = null;
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
    const unavailable = this.unavailable();
    const m = this.found?.manifest;
    return {
      version: this.deps.version,
      channel: this.deps.settings.get().channel,
      status: unavailable ? "unavailable" : this.status,
      reason: unavailable ?? this.reason,
      update: unavailable || !m ? null : { version: m.version, channel: m.channel, publishedAt: m.publishedAt, notes: m.notes },
      jobs: null,
      lastCheckedAt: this.lastCheckedAt,
      lastUpdate: this.lastUpdate,
    };
  }

  /** With the service: read what the last Update did, and keep watching while its installer has yet to say. */
  start(): void {
    this.settle();
  }

  stop(): void {
    if (this.watch) this.deps.clock.clearTimeout(this.watch);
    this.watch = null;
  }

  /** Check now: look for an Update and answer with the status after it. A check already running is joined, not repeated. */
  async check(_options: CheckOptions = {}): Promise<UpdatesView> {
    if (this.unavailable() || this.busy()) return this.view();
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
   * Install now: check, download and verify the Update, and start its installer, which restarts the service.
   * Answers once the installer runs (`installing`), or with why nothing was installed. A request while one runs joins it.
   */
  install(): Promise<UpdatesView> {
    if (this.unavailable()) return Promise.resolve(this.view());
    if (!this.installing) {
      const run = this.runInstall().finally(() => {
        if (this.installing === run) this.installing = null;
      });
      this.installing = run;
    }
    return this.installing;
  }

  /** Change this Machine's Updates settings. A new channel forgets what the old one found; the next check looks again. */
  setSettings(input: { channel?: UpdateChannel | undefined }): UpdatesView {
    const current = this.deps.settings.get();
    const next: UpdateSettings = { ...current, ...(input.channel ? { channel: input.channel } : {}) };
    if (next.channel === current.channel) return this.view();
    this.deps.settings.set(next);
    this.generation++;
    this.running = null;
    if (!this.busy()) {
      this.status = "not_checked";
      this.reason = null;
      this.found = null;
    }
    this.deps.changed();
    return this.view();
  }

  /** Whether an Update is downloading or installing: a check or a channel change must not cut in. */
  private busy(): boolean {
    return this.status === "downloading" || this.status === "installing";
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
    this.set(outcome.status, outcome.reason);
  }

  private async runInstall(): Promise<UpdatesView> {
    if (this.busy()) return this.view();
    await this.check();
    const found = this.found;
    if (this.status !== "available" || !found) return this.view();
    const to = found.manifest.version;
    const port = this.deps.port();
    if (port === null) {
      this.set("check_failed", `The Update to Attache ${to} cannot start before the service answers on its port. Try again in a moment.`);
      return this.view();
    }
    this.set("downloading");
    let staged;
    try {
      staged = await stageUpdate({ feed: this.deps.feed, found, target: this.deps.target!, stateDir: this.deps.stateDir, trustedKeys: this.deps.trustedKeys() });
    } catch (e) {
      const reason = e instanceof ReleaseRefusedError ? `The Update to Attache ${to} was refused: ${e.message}` : `The download of Attache ${to} failed. ${unreachable(this.deps.feed, e).message}`;
      this.deps.log.warn("the Update was not installed", { version: to, reason });
      this.set("check_failed", reason);
      return this.view();
    }
    recordInstallRequest(this.deps.stateDir, { from: this.deps.version, to, notes: staged.manifest.notes, at: this.deps.clock.now().toISOString() });
    this.set("installing");
    try {
      await this.deps.runner.start({ from: this.deps.version, version: to, release: staged.folder, archive: staged.archive, prefix: this.deps.install!.prefix, stateDir: this.deps.stateDir, port });
    } catch (e) {
      forgetInstallRequest(this.deps.stateDir);
      const reason = `Attache could not start the installer for ${to}, so nothing was changed: ${(e as Error).message}`;
      this.deps.log.warn("the installer did not start", { version: to, error: (e as Error).message });
      this.set("check_failed", reason);
      return this.view();
    }
    this.deps.log.info("the installer for an Update started; it restarts the service", { from: this.deps.version, to });
    this.watchForOutcome();
    return this.view();
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
      this.clearStaged();
      if (this.status === "installing") this.set(this.found ? "available" : "not_checked");
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
    try {
      const left = clearStaging(this.deps.stateDir);
      if (left.length) this.deps.log.info("a staged release is still in use; it is removed with the next Update", { left });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.deps.log.warn("could not clear the staged release", { error: (e as Error).message });
    }
  }
}
