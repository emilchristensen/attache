import { MIGRATIONS, openDb, type Db } from "../../src/core/db.ts";

/**
 * The state database an install had just before the first migration matching `next`, for a test that
 * upgrades it: every earlier migration, run by the service's own code, so the file is in WAL mode with
 * one transaction per migration, as an install's always was. The caller adds the rows and closes it.
 */
export function databaseBefore(file: string, next: RegExp): Db {
  const version = MIGRATIONS.findIndex((m) => next.test(m));
  if (version <= 0) throw new Error(`no migration matches ${next}, so there is no schema from before it`);
  return openDb(file, version);
}
