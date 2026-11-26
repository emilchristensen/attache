/**
 * Updates in the owner's words (spec #130): the sentences `attache update`, Settings' Updates section, the line under
 * the masthead and the system notifications all say, kept once so every place says a thing alike. Each place adds
 * only what is its own: a next step, a button, where to find a setting.
 */
import type { LastUpdateView, RollbackDatabase, UpdateChannel, UpdatesStatus, UpdatesView } from "./updates.ts";
import { plural } from "./wording.ts";

export const CHANNEL_LABEL: Record<UpdateChannel, string> = { stable: "Stable", beta: "Beta" };

/** "Attache 0.7.0" for the Update a view names; the status names one whenever it has it. */
const named = (v: Pick<UpdatesView, "update">, fallback: string): string => (v.update ? `Attache ${v.update.version}` : fallback);

const HEADLINE: Record<UpdatesStatus, (v: UpdatesView) => string> = {
  unavailable: () => "Updates are unavailable on this Machine",
  off: () => "Automatic updates is Off",
  not_checked: () => "Not checked yet",
  checking: () => "Looking for an Update…",
  up_to_date: () => "Attache is up to date",
  available: (v) => `${named(v, "An Update")} is available`,
  downloading: (v) => `Downloading ${named(v, "the Update")}…`,
  ready: (v) => `${named(v, "An Update")} is ready to install`,
  waiting_for_jobs: (v) => `${named(v, "An Update")} is waiting for ${plural(v.jobs ?? 0, "Job")} to finish`,
  // A service that restarted while the installer runs knows no manifest: it still says what happens.
  installing: (v) => `Installing ${named(v, "an Update")}`,
  check_failed: () => "The last check failed",
};

/** What the Updates status says, in one sentence without a full stop. */
export function updatesHeadline(v: UpdatesView): string {
  return HEADLINE[v.status](v);
}

/** Why Automatic updates is Off reads as it does: it makes no request at all. */
export const UPDATES_OFF_DETAIL = "Attache does not look for Updates and makes no request about them.";

/**
 * Which button installs from this status: Install now for a found or verified Update (also one a failed download kept),
 * Restart now while it waits for Jobs, else none. `attache update` installs from the same statuses.
 */
export function installAction(v: UpdatesView): "install" | "restart" | null {
  if (!v.update) return null;
  switch (v.status) {
    case "available":
    case "ready":
    case "check_failed":
      return "install";
    case "waiting_for_jobs":
      return "restart";
    default:
      return null;
  }
}

/** What the last Update did, in one sentence without a full stop. */
export function lastUpdateHeadline(last: LastUpdateView): string {
  switch (last.outcome) {
    case "updated":
      return `Attache updated from ${last.from} to ${last.to}`;
    case "rolled_back":
      return `The Update to ${last.to} failed, so Attache went back to ${last.from}`;
    case "failed":
      return `The Update to ${last.to} did not install, so Attache stayed on ${last.from}`;
  }
}

/** Why the last Update did not install, and for a rollback what became of the database; null after a successful one. */
export function lastUpdateDetail(last: LastUpdateView): string | null {
  switch (last.outcome) {
    case "updated":
      return null;
    case "rolled_back":
      return rollbackDetail(last);
    case "failed":
      return last.reason;
  }
}

/**
 * What a rolled-back Update did with the database, as one or two sentences (`LastUpdateView`'s `database` and
 * `backup`), or null when the installer did not say. `from` is the version the Machine went back to.
 */
export function rollbackDatabaseSentence(rollback: { from: string; database: RollbackDatabase | null; backup: string | null }): string | null {
  switch (rollback.database) {
    case "restored":
      return "The database was restored from the backup taken just before the Update.";
    case "no_backup":
      return `The database was not restored, because Attache ${rollback.from} could not open it to back it up before the Update.`;
    case "restore_failed":
      return rollback.backup
        ? `The database could not be restored from ${rollback.backup}. To restore it, run attache stop, then attache restore "${rollback.backup}" --database-only, then attache start.`
        : "The database could not be restored from the backup taken before the Update.";
    case null:
      return null;
  }
}

/** Why a rolled-back Update failed, followed by what became of the database when the installer said. */
export function rollbackDetail(rollback: { from: string; reason: string; database: RollbackDatabase | null; backup: string | null }): string {
  const database = rollbackDatabaseSentence(rollback);
  return database ? `${rollback.reason.replace(/\.$/, "")}. ${database}` : rollback.reason;
}

/** Why Automatic updates and the Update channel cannot change now: an Update to `to` is installing (null when unknown). */
export function settingsLockedWhileInstalling(to: string | null): string {
  return `Automatic updates and the Update channel can change once ${to ? `Attache ${to}` : "the Update"} has finished installing.`;
}

/** What the owner is asked while Replication is paused on a Brain format this Machine's Attache cannot read. */
export const PAUSED_FOR_UPDATE = "Update this Machine to keep replicating";
