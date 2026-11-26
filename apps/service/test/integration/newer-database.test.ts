import { describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, migrate, openDb } from "../../src/core/db.ts";
import { REFUSED_EXIT_CODE, REFUSED_TO_START_FILE } from "../../src/platform/service-manager/types.ts";

// Each case starts the real command line as a child process, which loads the whole service from source.
const MAIN = join(import.meta.dirname, "../../src/main.ts");
const NEWER = "0.9.0";
const OLDER = "0.6.1";

/** A migration this Attache does not know, as the next release might ship it. */
const FROM_THE_FUTURE = "create table from_the_future (id integer primary key);";

/** A database exactly as Attache NEWER leaves it after migrating to one schema version more than this Attache knows. */
function newerDatabase(file: string, writtenBy: string | null = NEWER): void {
  const db = new DatabaseSync(file);
  try {
    migrate(db, { migrations: [...MIGRATIONS, FROM_THE_FUTURE], version: writtenBy ?? NEWER });
    // An install whose newest migration was applied without a record of who applied it.
    if (!writtenBy) db.exec("delete from schema_writer");
  } finally {
    db.close();
  }
}

function newerState(writtenBy: string | null = NEWER): string {
  const stateDir = mkdtempSync(join(tmpdir(), "attache-it-newer-db-"));
  newerDatabase(join(stateDir, "attache.sqlite"), writtenBy);
  return stateDir;
}

function schemaOf(file: string): { version: number; tables: string[] } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const version = Number((db.prepare("pragma user_version").get() as { user_version: number }).user_version);
    const tables = (db.prepare("select name from sqlite_master where type = 'table' order by name").all() as Array<{ name: string }>).map((t) => t.name);
    return { version, tables };
  } finally {
    db.close();
  }
}

/** The real command line, as Attache OLDER. */
function attache(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_SESSION_ID|CLAUDE_CODE_|CODEX_|ANTIGRAVITY_)/.test(k)));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], { env: { ...clean, ATTACHE_VERSION: OLDER } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    // A service that starts anyway would never exit: stop it so the case fails instead of leaving it running.
    const stray = setTimeout(() => child.kill(), 20_000);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(stray);
      resolve({ status, stdout, stderr });
    });
    child.stdin.end();
  });
}

const REFUSAL = `attache: This Machine's database was written by Attache ${NEWER}, which is newer than this Attache (${OLDER}). Install Attache ${NEWER} or newer again to keep using it. Nothing was changed.\n`;

describe("a database newer than this Attache", () => {
  it("the service refuses to start on it, says which Attache to install, and leaves it untouched", async () => {
    const stateDir = newerState();
    const db = join(stateDir, "attache.sqlite");
    const before = schemaOf(db);

    const serve = await attache(["serve", "--state-dir", stateDir, "--port", "0"]);
    expect(serve.stderr).toBe(REFUSAL);
    // The exit code and file that tell launchd, systemd and the Windows supervisor not to start it again and again.
    expect(serve.status).toBe(REFUSED_EXIT_CODE);
    expect(readFileSync(join(stateDir, REFUSED_TO_START_FILE), "utf8")).toBe(REFUSAL.replace(/^attache: /, ""));
    expect(existsSync(join(stateDir, "runtime.json")), "no service is announced").toBe(false);
    expect(schemaOf(db)).toEqual(before);
    expect(before.version).toBe(MIGRATIONS.length + 1);
  });

  it("once the service starts again, it is kept running again", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "attache-it-started-again-"));
    writeFileSync(join(stateDir, REFUSED_TO_START_FILE), "an earlier refusal\n");
    const child = spawn(process.execPath, [MAIN, "serve", "--state-dir", stateDir, "--port", "0"], { env: { ...process.env, ATTACHE_VERSION: OLDER }, stdio: "ignore" });
    try {
      const deadline = Date.now() + 60_000;
      while (!existsSync(join(stateDir, "runtime.json")) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(join(stateDir, "runtime.json")), "the service started").toBe(true);
      expect(existsSync(join(stateDir, REFUSED_TO_START_FILE))).toBe(false);
    } finally {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    }
  });

  it("every command that opens the database refuses the same way", async () => {
    const stateDir = newerState();
    const before = schemaOf(join(stateDir, "attache.sqlite"));
    for (const args of [["pair"], ["search", "Zephyr"], ["backup"]]) {
      const r = await attache([...args, "--state-dir", stateDir]);
      expect(r.stderr, args.join(" ")).toBe(REFUSAL);
      expect(r.status, args.join(" ")).toBe(1);
      expect(r.stdout, args.join(" ")).toBe("");
    }
    expect(schemaOf(join(stateDir, "attache.sqlite"))).toEqual(before);
  });

  it("restoring a backup a newer Attache made is refused before the current database is touched", async () => {
    const work = mkdtempSync(join(tmpdir(), "attache-it-newer-backup-"));
    newerDatabase(join(work, "attache.sqlite"));
    writeFileSync(join(work, "manifest.json"), JSON.stringify({ format: "attache-backup-1", version: NEWER, createdAt: new Date().toISOString(), instance: "default", dataFolder: null, includesData: false, credentialsIncluded: false, connectionsNeedingReconnect: [] }));
    const archive = join(mkdtempSync(join(tmpdir(), "attache-it-newer-archive-")), "newer.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", work, "."]);

    const stateDir = mkdtempSync(join(tmpdir(), "attache-it-restore-into-"));
    mkdirSync(stateDir, { recursive: true });
    const current = await attache(["pair", "--state-dir", stateDir, "--json"]);
    expect(current.status).toBe(0);
    const before = schemaOf(join(stateDir, "attache.sqlite"));

    const r = await attache(["restore", archive, "--state-dir", stateDir, "--force"]);
    expect(r.stderr).toBe(REFUSAL);
    expect(r.status).toBe(1);
    expect(schemaOf(join(stateDir, "attache.sqlite"))).toEqual(before);
  });

  it("without a record of the newer version, the refusal still says to install the newer Attache", async () => {
    const stateDir = newerState(null);
    const r = await attache(["serve", "--state-dir", stateDir, "--port", "0"]);
    expect(r.stderr).toBe(`attache: This Machine's database was written by a newer Attache than this one (${OLDER}). Install the newest Attache again to keep using it. Nothing was changed.\n`);
    expect(r.status).toBe(REFUSED_EXIT_CODE);
  });

  it("a database at the schema this Attache knows opens as before, and an older one migrates", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "attache-it-known-db-"));
    // The schema an install had one migration ago.
    openDb(join(stateDir, "attache.sqlite"), MIGRATIONS.length - 1).close();

    const migrated = await attache(["pair", "--state-dir", stateDir, "--json"]);
    expect(migrated.stderr).toBe("");
    expect(migrated.status).toBe(0);
    expect(schemaOf(join(stateDir, "attache.sqlite")).version).toBe(MIGRATIONS.length);

    const again = await attache(["pair", "--state-dir", stateDir, "--json"]);
    expect(again.stderr).toBe("");
    expect(again.status).toBe(0);
  });
});
