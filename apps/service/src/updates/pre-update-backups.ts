/**
 * Pre-Update backups (spec #130, ticket #138): the backup an installer takes
 * just before it installs over an existing install, and restores the database
 * from when it rolls back. The installers name it
 * `pre-update-<from>-to-<to>-<stamp>.tar.gz` in the backups folder
 * (`installer/install.sh`, `installer/install.ps1`); installers from before
 * Updates named it `pre-upgrade-…`, which counts too. After a successful
 * install the installer runs `attache prune-backups`, which keeps the newest
 * `KEEP_PRE_UPDATE_BACKUPS`. Backups the owner made (`attache-backup-…`) are
 * never touched.
 */
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** How many pre-Update backups stay after a successful install. */
export const KEEP_PRE_UPDATE_BACKUPS = 3;

const PRE_UPDATE_BACKUP = /^pre-(update|upgrade)-.+\.tar\.gz$/;

export const isPreUpdateBackup = (name: string): boolean => PRE_UPDATE_BACKUP.test(name);

/**
 * Remove every pre-Update backup in `backupsDir` but the newest `keep`, newest by when the archive was written:
 * the names hold versions and a local time, neither of which orders them. Returns the paths it removed.
 */
export function prunePreUpdateBackups(backupsDir: string, keep = KEEP_PRE_UPDATE_BACKUPS): string[] {
  if (!existsSync(backupsDir)) return [];
  const backups = readdirSync(backupsDir)
    .filter(isPreUpdateBackup)
    .map((name) => ({ path: join(backupsDir, name), madeAt: statSync(join(backupsDir, name)).mtimeMs }))
    .sort((a, b) => b.madeAt - a.madeAt);
  const removed = backups.slice(keep).map((b) => b.path);
  for (const path of removed) rmSync(path, { force: true });
  return removed.reverse();
}
