// `attache update --check` from a terminal, against a test service that reads a local stand-in for GitHub Releases.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { releaseTarget } from "../../src/platform/release-target.ts";
import { signedRelease } from "../fixtures/signed-release.ts";
import type { TestService } from "./harness.ts";
import { installerFinished, updatesWorld } from "./updates-world.ts";

// Each test starts the `attache` executable from source, which is slow while the whole suite runs in parallel.
vi.setConfig({ testTimeout: 120_000 });

const MAIN = join(import.meta.dirname, "../../src/main.ts");
const { key, releases, machine, restart } = updatesWorld();

/** The real CLI, pinned to one test service's state folder. Asynchronous: the service runs in this process. */
function cli(svc: TestService, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_SESSION_ID|CLAUDE_CODE_|CODEX_|ANTIGRAVITY_)/.test(k)));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args, "--state-dir", svc.stateDir], { env: clean });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end();
  });
}

describe("attache update --check", () => {
  it("reports the installed version, the channel and the newest version this Machine may take", async () => {
    const svc = await machine("0.6.0", await releases("0.6.1", "0.7.0", "0.8.0-beta.1"));
    const r = await cli(svc, ["update", "--check"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("Attache 0.6.0, Update channel Stable\nAttache 0.7.0 is available.\n");

    await svc.put("/updates/settings", { channel: "beta" });
    expect((await cli(svc, ["update", "--check"])).stdout).toBe("Attache 0.6.0, Update channel Beta\nAttache 0.8.0-beta.1 is available.\n");
  });

  it("says when the Machine is up to date", async () => {
    const svc = await machine("0.7.0", await releases("0.6.1", "0.7.0"));
    const r = await cli(svc, ["update", "--check"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("Attache 0.7.0, Update channel Stable\nAttache is up to date.\n");
  });

  it("fails with the reason when the check fails, so it never reads as up to date", async () => {
    const server = await releases("0.7.0");
    const svc = await machine("0.6.0", server);
    server.failWith(503);
    const r = await cli(svc, ["update", "--check"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe("Attache 0.6.0, Update channel Stable\n");
    expect(r.stderr).toMatch(/^attache: The check for an Update failed: 127\.0\.0\.1:\d+ answered HTTP 503/);
  });

  it("says Updates are unavailable on a source checkout", async () => {
    const svc = await machine("0.6.0", await releases("0.7.0"), { releaseInstall: false });
    const r = await cli(svc, ["update", "--check"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("attache: Updates are unavailable here: Attache runs from a source checkout");
  });

  it("prints the whole status as JSON for scripts", async () => {
    const svc = await machine("0.6.0", await releases("0.7.0"));
    const r = await cli(svc, ["update", "--check", "--json"]);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ version: "0.6.0", channel: "stable", status: "available", update: { version: "0.7.0" } });
  });
});

describe("attache update", () => {
  it("installs the Update, waits for the restart and says which version the Machine updated from", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    // Play the installer: it stops the service, starts the new version, checks its health, then writes its outcome.
    m.runner.onStart = async () => {
      const after = await restart(m, "0.7.0");
      installerFinished(after.stateDir, { outcome: "updated", from: "0.6.0", to: "0.7.0" });
    };
    const r = await cli(m, ["update"]);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("Installing Attache 0.7.0. Attache restarts to finish the Update.\nAttache updated from 0.6.0 to 0.7.0.\n");
  });

  it("fails with the reason when the installer changed nothing", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    m.runner.onStart = () => installerFinished(m.stateDir, { outcome: "failed", from: "0.6.0", to: "0.7.0", reason: "could not back up the existing installation; nothing was changed" });
    const r = await cli(m, ["update"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("attache: The Update to Attache 0.7.0 failed, and Attache stayed on 0.6.0: could not back up the existing installation; nothing was changed\n");
  });

  it("fails with the reason when the Update went back to the earlier version", async () => {
    const m = await machine("0.6.0", await releases("0.7.0"));
    m.runner.onStart = async () => {
      const after = await restart(m, "0.6.0");
      installerFinished(after.stateDir, { outcome: "rolled_back", from: "0.6.0", to: "0.7.0", reason: "the service did not become healthy" });
    };
    const r = await cli(m, ["update"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe("attache: The Update to Attache 0.7.0 failed, so Attache went back to 0.6.0: the service did not become healthy\n");
  });

  for (const [database, said] of [
    ["restored", "The database was restored from the backup taken just before the Update."],
    ["no_backup", "The database was not restored, because Attache 0.6.0 could not open it to back it up before the Update."],
    ["restore_failed", 'The database could not be restored from BACKUP. To restore it, run attache stop, then attache restore "BACKUP" --database-only, then attache start.'],
  ] as const) {
    it(`says what became of the database after a rollback (${database})`, async () => {
      const m = await machine("0.6.0", await releases("0.7.0"));
      const backup = join(m.stateDir, "backups", "pre-update-0.6.0-to-0.7.0-20261126101500.tar.gz");
      m.runner.onStart = async () => {
        const after = await restart(m, "0.6.0");
        installerFinished(after.stateDir, { outcome: "rolled_back", from: "0.6.0", to: "0.7.0", reason: "the service did not become healthy", database, ...(database === "no_backup" ? {} : { backup }) });
      };
      const r = await cli(m, ["update"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toBe(`attache: The Update to Attache 0.7.0 failed, so Attache went back to 0.6.0: the service did not become healthy. ${said.replaceAll("BACKUP", backup)}\n`);
    });
  }

  it("says when there is nothing to install", async () => {
    const m = await machine("0.7.0", await releases("0.7.0"));
    const r = await cli(m, ["update"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("Attache 0.7.0, Update channel Stable\nAttache is up to date.\n");
    expect(m.runner.requests).toEqual([]);
  });

  it("fails with the reason when the download is refused", async () => {
    const server = await releases();
    const release = signedRelease({ version: "0.7.0", key });
    writeFileSync(release.artifacts[releaseTarget()!]!, "not the archive the manifest names");
    server.publish("0.7.0", release);
    const m = await machine("0.6.0", server);
    const r = await cli(m, ["update"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/^attache: The Update to Attache 0\.7\.0 was refused: attache-0\.7\.0-\S+ does not match the signed manifest, so it was refused\.\n$/);
    expect(m.runner.requests).toEqual([]);
  });
});
