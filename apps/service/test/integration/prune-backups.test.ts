// `attache prune-backups`: after a successful install, the installer keeps only the 3 newest pre-Update backups
// (spec #130, ticket #138). Backups the owner made are never touched.
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { testFolder } from "./harness.ts";

// Starts the `attache` executable from source, which is slow while the whole suite runs in parallel.
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

/** Backups in the order they were made, oldest first, each a minute after the one before. */
function backupsMade(stateDir: string, names: string[]): void {
  const dir = join(stateDir, "backups");
  mkdirSync(dir, { recursive: true });
  const start = Date.parse("2026-11-01T10:00:00Z") / 1000;
  names.forEach((name, i) => {
    writeFileSync(join(dir, name), name);
    utimesSync(join(dir, name), start + i * 60, start + i * 60);
  });
}

describe("attache prune-backups", () => {
  it("keeps the 3 newest pre-Update backups, by when they were made, and every backup the owner made", async () => {
    const stateDir = testFolder("state");
    backupsMade(stateDir, [
      // An installer from before Updates named its backup with the older label.
      "pre-upgrade-0.5.0-to-0.6.0-20261101100000.tar.gz",
      "attache-backup-2026-11-01T10-01-00-000Z.tar.gz",
      "pre-update-0.6.0-to-0.7.0-20261101100200.tar.gz",
      "attache-backup-2026-11-01T10-03-00-000Z-before-join.tar.gz",
      // Made later, though its name sorts first.
      "pre-update-0.10.0-to-0.11.0-20261101100400.tar.gz",
      "pre-update-0.7.0-to-0.8.0-20261101100500.tar.gz",
      "pre-update-0.8.0-to-0.9.0-20261101100600.tar.gz",
      "attache-backup-2026-11-01T10-07-00-000Z.tar.gz",
    ]);

    const r = await attache(["prune-backups", "--state-dir", stateDir]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      removed: ["pre-upgrade-0.5.0-to-0.6.0-20261101100000.tar.gz", "pre-update-0.6.0-to-0.7.0-20261101100200.tar.gz"].map((f) => join(stateDir, "backups", f)),
    });
    expect(readdirSync(join(stateDir, "backups")).sort()).toEqual(
      [
        "attache-backup-2026-11-01T10-01-00-000Z.tar.gz",
        "attache-backup-2026-11-01T10-03-00-000Z-before-join.tar.gz",
        "attache-backup-2026-11-01T10-07-00-000Z.tar.gz",
        "pre-update-0.10.0-to-0.11.0-20261101100400.tar.gz",
        "pre-update-0.7.0-to-0.8.0-20261101100500.tar.gz",
        "pre-update-0.8.0-to-0.9.0-20261101100600.tar.gz",
      ].sort(),
    );
  });

  it("removes nothing with 3 pre-Update backups or fewer, or no backups folder at all", async () => {
    const stateDir = testFolder("state");
    expect(JSON.parse((await attache(["prune-backups", "--state-dir", stateDir])).stdout)).toEqual({ removed: [] });
    backupsMade(stateDir, ["pre-update-0.6.0-to-0.7.0-20261101100000.tar.gz", "pre-update-0.7.0-to-0.8.0-20261101100100.tar.gz", "pre-update-0.8.0-to-0.9.0-20261101100200.tar.gz"]);
    expect(JSON.parse((await attache(["prune-backups", "--state-dir", stateDir])).stdout)).toEqual({ removed: [] });
    expect(readdirSync(join(stateDir, "backups"))).toHaveLength(3);
  });
});
