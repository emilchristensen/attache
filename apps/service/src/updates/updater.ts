/**
 * The Updater (spec #130, "Updater"): the deep module behind Updates. It owns
 * the whole lifecycle behind a small interface: the status (`view`), Check now
 * (`check`), Install now and Restart now (`install`, to come), and this
 * Machine's settings (`setSettings`). Everything else (the release feed, the
 * signature checks, the installer runner, the timers) stays inside.
 *
 * What exists now: finding the right Update on demand. The rest of the
 * lifecycle extends this class rather than adding a second one:
 * - downloading and staging the artifact, `install()` and the installer runner port (#137);
 * - reading the installer's outcome after a restart into `lastUpdate`, and marking a rolled-back version bad (#138);
 * - Automatic updates' modes, the check at start and every 6 hours, waiting for Jobs (#139): `start()`/`stop()` on the App's clock.
 */
import type { UpdateChannel, UpdateSettings, UpdatesStatus, UpdatesView } from "@attache/contracts";
import type { Logger } from "../core/log.ts";
import type { ReleaseManifest } from "../release/manifest.ts";
import type { Clock } from "../replication/clock.ts";
import { badVersions } from "./bad-versions.ts";
import { findUpdate, UpdateCheckError } from "./find-update.ts";
import type { ReleaseFeed } from "./release-feed.ts";
import type { ReleaseInstall } from "./release-install.ts";

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
}

export interface CheckOptions {
  /** Only find out what is available: download and install nothing, whatever the mode. Nothing acts on a check yet (#137, #139 make it). */
  reportOnly?: boolean;
}

export class Updater {
  private readonly deps: UpdaterDeps;
  private status: UpdatesStatus = "not_checked";
  private reason: string | null = null;
  private update: ReleaseManifest | null = null;
  private lastCheckedAt: string | null = null;
  private running: Promise<void> | null = null;
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
    const m = this.update;
    return {
      version: this.deps.version,
      channel: this.deps.settings.get().channel,
      status: unavailable ? "unavailable" : this.status,
      reason: unavailable ?? this.reason,
      update: unavailable || !m ? null : { version: m.version, channel: m.channel, publishedAt: m.publishedAt, notes: m.notes },
      jobs: null,
      lastCheckedAt: this.lastCheckedAt,
      lastUpdate: null,
    };
  }

  /** Check now: look for an Update and answer with the status after it. A check already running is joined, not repeated. */
  async check(_options: CheckOptions = {}): Promise<UpdatesView> {
    if (this.unavailable()) return this.view();
    if (!this.running) {
      const run = this.runCheck().finally(() => {
        if (this.running === run) this.running = null;
      });
      this.running = run;
    }
    await this.running;
    return this.view();
  }

  /** Change this Machine's Updates settings. A new channel forgets what the old one found; the next check looks again. */
  setSettings(input: { channel?: UpdateChannel | undefined }): UpdatesView {
    const current = this.deps.settings.get();
    const next: UpdateSettings = { ...current, ...(input.channel ? { channel: input.channel } : {}) };
    if (next.channel === current.channel) return this.view();
    this.deps.settings.set(next);
    this.generation++;
    this.running = null;
    this.status = "not_checked";
    this.reason = null;
    this.update = null;
    this.deps.changed();
    return this.view();
  }

  private async runCheck(): Promise<void> {
    const generation = this.generation;
    this.status = "checking";
    this.deps.changed();
    let outcome: { status: UpdatesStatus; reason: string | null; update: ReleaseManifest | null };
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
      outcome = found ? { status: "available", reason: null, update: found } : { status: "up_to_date", reason: null, update: null };
    } catch (e) {
      const reason = e instanceof UpdateCheckError ? e.message : `The check for an Update failed: ${(e as Error).message}`;
      this.deps.log.warn("the check for an Update failed", { reason, error: (e as Error).message });
      // What an earlier check found and verified stays true; only this check failed.
      outcome = { status: "check_failed", reason, update: this.update };
    }
    if (generation !== this.generation) return;
    this.status = outcome.status;
    this.reason = outcome.reason;
    this.update = outcome.update;
    this.lastCheckedAt = this.deps.clock.now().toISOString();
    this.deps.changed();
  }
}
