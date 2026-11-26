// `attache update --check` from a terminal, against a test service that reads a local stand-in for GitHub Releases.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TestService } from "./harness.ts";
import { updatesWorld } from "./updates-world.ts";

// Each test starts the `attache` executable from source, which is slow while the whole suite runs in parallel.
vi.setConfig({ testTimeout: 120_000 });

const MAIN = join(import.meta.dirname, "../../src/main.ts");
const { releases, machine } = updatesWorld();

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
