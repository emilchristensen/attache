import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "./helpers.ts";
import { databaseBefore } from "./fixtures/old-database.ts";

const tables = (db: ReturnType<typeof databaseBefore>) => (db.prepare("select name from sqlite_master where type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);

describe("an old install's database", () => {
  it("has the schema from just before the given migration, and none of that migration's changes", () => {
    const db = databaseBefore(join(tempDir(), "attache.sqlite"), /drop table if exists messages/);
    try {
      expect(tables(db)).toEqual(expect.arrayContaining(["config", "conversations", "messages"]));
      expect(Number((db.prepare("pragma user_version").get() as { user_version: number }).user_version)).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  // An install's database was always written by the service: in WAL mode, one transaction per migration.
  // Written a statement at a time in the default rollback journal, each statement waits for its own disk
  // flush, which took the chat-removal upgrade test past 30 s on a busy Windows runner (#53).
  it("is written the way the service writes its own, in WAL mode", () => {
    const db = databaseBefore(join(tempDir(), "attache.sqlite"), /drop table if exists messages/);
    try {
      expect((db.prepare("pragma journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal");
    } finally {
      db.close();
    }
  });

  it("names a migration that does not exist", () => {
    expect(() => databaseBefore(join(tempDir(), "attache.sqlite"), /no migration says this/)).toThrow(/no migration matches/);
  });
});
