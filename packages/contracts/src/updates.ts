import { z } from "zod";

/** API contract: Updates (spec #130, ADR 0007). */

/** Which releases a Machine takes Updates from: Stable, or Beta, which also takes each Stable release that is newer. */
export const UpdateChannel = z.enum(["stable", "beta"]);
export type UpdateChannel = z.infer<typeof UpdateChannel>;

/**
 * Automatic updates on this Machine:
 * - `automatic` (the default): an Update installs on its own once no Job is running, or after it has waited 24 hours for Jobs;
 * - `ask_first`: an Update is downloaded and verified, then waits for Install now;
 * - `off`: Attache makes no request about Updates at all, not even for Check now or Install now.
 */
export const UpdateMode = z.enum(["automatic", "ask_first", "off"]);
export type UpdateMode = z.infer<typeof UpdateMode>;

/**
 * Updates on this Machine: its configuration, never a Preference (ADR 0005).
 * Every field is optional with a default, so a configuration saved before
 * Updates existed reads as Stable and Automatic.
 */
export const UpdateSettings = z.object({
  channel: UpdateChannel.default("stable"),
  mode: UpdateMode.default("automatic"),
});
export type UpdateSettings = z.infer<typeof UpdateSettings>;

/** `PUT /updates/settings`: change what is named, keep the rest. */
export const UpdateSettingsInput = z
  .object({ channel: UpdateChannel.optional(), mode: UpdateMode.optional() })
  .refine((s) => Object.values(s).some((v) => v !== undefined), "Name a setting to change");
export type UpdateSettingsInput = z.infer<typeof UpdateSettingsInput>;

/** `POST /updates/check`. */
export const UpdateCheckInput = z.object({
  /**
   * Only report what is available: download and install nothing, whatever Automatic updates says. `attache update --check` asks this.
   * Without it, the check acts as the one every 6 hours does: Automatic goes on to install, Ask first to download and wait at `ready`.
   */
  reportOnly: z.boolean().default(false),
});
export type UpdateCheckInput = z.infer<typeof UpdateCheckInput>;

/**
 * Where the Updater stands. The whole lifecycle is listed here, so every place
 * that words a status handles each one:
 * - `unavailable`: this copy cannot update itself (a source checkout, or a build without a release key); `reason` says why.
 * - `off`: Automatic updates is Off, so nothing is checked and no request is made.
 * - `not_checked`: no check has run since the service started.
 * - `checking`: a check is running.
 * - `up_to_date`: the last check found no newer release in the channel.
 * - `available`: the last check found `update`, verified its signed manifest, and nothing more happened yet.
 * - `downloading`: `update`'s artifact for this computer is downloading.
 * - `ready`: `update` is downloaded and verified, and waits for Install (Ask first). A later check that fails leaves it ready, with `reason`.
 * - `waiting_for_jobs`: `update` waits for `jobs` Jobs to finish before it installs.
 * - `installing`: the installer runs; the service is about to restart.
 * - `check_failed`: the last check, or the download of `update`, did not finish or was refused; `reason` says why. Never read as up to date.
 */
export const UpdatesStatus = z.enum(["unavailable", "off", "not_checked", "checking", "up_to_date", "available", "downloading", "ready", "waiting_for_jobs", "installing", "check_failed"]);
export type UpdatesStatus = z.infer<typeof UpdatesStatus>;

/** A release the Updater found, from its verified manifest. */
export interface AvailableUpdateView {
  version: string;
  channel: UpdateChannel;
  publishedAt: string;
  /** Release notes in Markdown, from the signed manifest, so the Dashboard shows them without loading anything from the internet. */
  notes: string;
}

/**
 * What a rollback did with the database, which the version being installed may have changed:
 * - `restored`: put back from the pre-Update backup taken just before the switch.
 * - `no_backup`: left as it was, because no pre-Update backup was taken (the installed version could not open the
 *   database a newer Attache wrote, so it could not back it up either).
 * - `restore_failed`: the pre-Update backup could not be put back; it is still in the backups folder.
 */
export const RollbackDatabase = z.enum(["restored", "no_backup", "restore_failed"]);
export type RollbackDatabase = z.infer<typeof RollbackDatabase>;

/**
 * What the last Update did, read from the outcome the installer left in the Machine's state:
 * - `updated`: the Machine moved from `from` to `to`; `notes` are `to`'s release notes.
 * - `rolled_back`: `to` did not come up, so the installer switched back to `from`, and `to` is never offered again on
 *   this Machine. `database` says what became of the database (null from an installer that did not say), and `backup`
 *   is the pre-Update backup it was restored from, or could not be (null when there was none).
 * - `failed`: the installer stopped before it changed anything, so the Machine stayed on `from`.
 */
export type LastUpdateView =
  | { outcome: "updated"; from: string; to: string; at: string; notes: string }
  | { outcome: "rolled_back"; from: string; to: string; at: string; reason: string; database: RollbackDatabase | null; backup: string | null }
  | { outcome: "failed"; from: string; to: string; at: string; reason: string };

export interface UpdatesView {
  /** The version this Machine runs. */
  version: string;
  channel: UpdateChannel;
  mode: UpdateMode;
  status: UpdatesStatus;
  /** Why Updates are unavailable or the last check failed (also while a verified Update stays `ready`); null otherwise. */
  reason: string | null;
  /** The newest release this Machine may take; null when none is known. */
  update: AvailableUpdateView | null;
  /** Running Jobs an Update waits for, while `waiting_for_jobs`; null otherwise. */
  jobs: number | null;
  /** When the last check finished, successfully or not. */
  lastCheckedAt: string | null;
  /** The outcome of the last Update on this Machine; null when there is none to tell. */
  lastUpdate: LastUpdateView | null;
}

/** Fired on the event stream whenever anything in `UpdatesView` changes; read `GET /updates` again. */
export const UPDATES_EVENT = "updates.changed";
export interface UpdatesChangedEvent {
  type: typeof UPDATES_EVENT;
}
