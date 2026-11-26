// `attache restore <backup> --database-only`: what an Update's rollback runs (spec #130, ticket #138). It puts back the
// database from the pre-Update backup and nothing else: the data folder, the pairings and the connections stay as they are.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MIGRATIONS, migrate } from "../../src/core/db.ts";
import { startTestService, testFolder } from "./harness.ts";

// Each case starts the `attache` executable from source a few times, which is slow while the whole suite runs in parallel.
vi.setConfig({ testTimeout: 120_000 });

const MAIN = join(import.meta.dirname, "../../src/main.ts");

function attache(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_SESSION_ID|CLAUDE_CODE_|CODEX_|ANTIGRAVITY_)/.test(k)));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args], { env: clean });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end();
  });
}

const schemaVersion = (file: string): number => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return Number((db.prepare("pragma user_version").get() as { user_version: number }).user_version);
  } finally {
    db.close();
  }
};

/** A Machine with a note and a paired client, backed up as the installer does before an Update, and then changed as a newer version would. */
async function updatedAfterABackup() {
  const svc = await startTestService();
  await svc.post("/memory/save", { confirmed: true, origin: { agent: "claude-code", sessionId: "rollback" }, items: [{ action: "create", type: "decision", title: "Helios budget", facts: [{ subject: "Decision", value: "Cap Helios at 40k" }] }] });
  const { stateDir, dataDir, token } = svc;
  await svc.stop();
  const backup = join(stateDir, "backups", "pre-update-0.6.0-to-0.7.0-20261126101500.tar.gz");
  const made = await attache(["backup", "--out", backup, "--state-dir", stateDir]);
  expect(made.stderr).toBe("");
  // The version being installed migrates the database past what the installed version knows, and writes to the data folder.
  const db = new DatabaseSync(join(stateDir, "attache.sqlite"));
  migrate(db, { migrations: [...MIGRATIONS, "create table from_the_update (id integer primary key);"], version: "0.7.0" });
  db.close();
  writeFileSync(join(dataDir, "written-by-0.7.0.md"), "# After the backup\n");
  return { stateDir, dataDir, token, backup };
}

describe("attache restore --database-only", () => {
  it("puts back the database from the backup, and leaves the data folder, the pairings and the configuration as they are", async () => {
    const { stateDir, dataDir, token, backup } = await updatedAfterABackup();

    const r = await attache(["restore", backup, "--database-only", "--state-dir", stateDir]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const said = JSON.parse(r.stdout) as { restored: boolean; database: string; keptAs: string };
    expect(said).toMatchObject({ restored: true, database: join(stateDir, "attache.sqlite") });

    expect(schemaVersion(join(stateDir, "attache.sqlite"))).toBe(MIGRATIONS.length);
    // The database it replaced is kept beside it, whole, in case the owner needs what the newer version wrote.
    expect(schemaVersion(said.keptAs)).toBe(MIGRATIONS.length + 1);
    expect(readFileSync(join(dataDir, "written-by-0.7.0.md"), "utf8")).toBe("# After the backup\n");

    const again = await startTestService({ stateDir, dataDir, setup: false });
    const answer = await fetch(`${again.url}/api/v1/memory/search?q=${encodeURIComponent("Helios budget")}`, { headers: { authorization: `Bearer ${token}` } });
    expect(answer.status).toBe(200);
    expect(((await answer.json()) as { hits: Array<{ text: string }> }).hits.some((h) => h.text.includes("Cap Helios at 40k"))).toBe(true);
    expect(again.app.config.get()).toMatchObject({ setupCompleted: true, dataFolder: dataDir });
    await again.stop();
  });

  it("refuses while the service runs, and changes nothing", async () => {
    const { stateDir, dataDir, backup } = await updatedAfterABackup();
    const svc = await startTestService({ stateDir, dataDir, setup: false }).catch((e: Error) => e);
    // A newer database is refused by this version's service; a stand-in runtime file plays the service that runs.
    expect(svc).toBeInstanceOf(Error);
    writeFileSync(join(stateDir, "runtime.json"), JSON.stringify({ pid: process.pid, port: 1, url: "http://127.0.0.1:1", version: "0.7.0", startedAt: new Date().toISOString(), instance: "test" }));

    const r = await attache(["restore", backup, "--database-only", "--state-dir", stateDir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^attache: The Attache service is running \(pid \d+\)\./);
    expect(schemaVersion(join(stateDir, "attache.sqlite"))).toBe(MIGRATIONS.length + 1);
  });

  it("refuses an archive that is not an Attache backup, and changes nothing", async () => {
    const { stateDir } = await updatedAfterABackup();
    const notABackup = join(testFolder("not-a-backup"), "notes.tar.gz");
    writeFileSync(notABackup, "not an archive");
    // SQLite's own -wal and -shm files come and go as the test reads the database.
    const files = () => readdirSync(stateDir).filter((f) => !/-(wal|shm)$/.test(f)).sort();
    const before = files();

    const r = await attache(["restore", notABackup, "--database-only", "--state-dir", stateDir]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^attache: .*notes\.tar\.gz is not an Attache backup/);
    expect(schemaVersion(join(stateDir, "attache.sqlite"))).toBe(MIGRATIONS.length + 1);
    expect(files()).toEqual(before);
    expect(existsSync(join(stateDir, "attache.sqlite.restoring"))).toBe(false);
  });
});
