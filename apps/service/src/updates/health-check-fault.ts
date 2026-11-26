/**
 * The install test's release built to fail its health check (`scripts/build-release.mjs --fail-health-check`,
 * spec #130 ticket #138). Its service does what a broken newer version does at its worst: it migrates the database
 * one step past what any release knows, and then exits without answering. The installer's health check fails, so it
 * rolls back; the version it goes back to only runs because the rollback restores the database from the pre-Update
 * backup. Every other bundle is built with the switch off as a constant (`apps/service/build.mjs`).
 */
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, migrate } from "../core/db.ts";
import { resolvePaths } from "../core/paths.ts";
import { VERSION } from "../core/version.ts";

/** Whether this build is the release built to fail its health check. Read as `process.env.X` exactly, so the build replaces it. */
export const builtToFailHealthCheck = (): boolean => process.env.ATTACHE_FAIL_HEALTH_CHECK === "1";

/** The migration no release ships. */
const BEYOND_EVERY_RELEASE = "create table release_built_to_fail (id integer primary key);";

/** Migrate the database past every release, then fail the start. Runs again on each restart, changing nothing more. */
export function failHealthCheck(stateDir: string | undefined): never {
  const db = new DatabaseSync(resolvePaths(stateDir).dbFile);
  try {
    db.exec("pragma journal_mode = wal; pragma busy_timeout = 5000;");
    migrate(db, { migrations: [...MIGRATIONS, BEYOND_EVERY_RELEASE], version: VERSION });
  } finally {
    db.close();
  }
  throw new Error(`Attache ${VERSION} was built to fail its health check, for the install test.`);
}
