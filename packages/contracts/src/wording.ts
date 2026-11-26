import type { RollbackDatabase } from "./updates.ts";

/**
 * Wording the service and the Dashboard both put in front of the owner, kept
 * here so both say a thing the same way.
 */

/** A count with its noun in the right number: `1 file`, `2 files`, `0 entries`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
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
