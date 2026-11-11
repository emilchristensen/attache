import { afterAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { createRemote } from "./machines.ts";

const MAIN = join(import.meta.dirname, "../../src/main.ts");
const services: TestService[] = [];

afterAll(async () => {
  for (const s of services) await s.stop();
});

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

describe("jarvis replication", () => {
  it("sets Replication up on one Machine and joins it from another, from a terminal", async () => {
    const remote = createRemote();
    const mac = await startTestService();
    services.push(mac);
    expect((await cli(mac, ["replication", "status"])).stdout).toContain("Replication is off");

    const setup = await cli(mac, ["replication", "setup", remote.url]);
    expect(setup.stderr).toBe("");
    expect(setup.status).toBe(0);
    expect(setup.stdout).toContain("Replication is up to date");
    expect(setup.stdout).toContain(remote.url);

    const pc = await startTestService({ setup: false });
    services.push(pc);
    const folder = join(mkdtempSync(join(tmpdir(), "jarvis-it-join-")), "brain");
    const join_ = await cli(pc, ["replication", "join", remote.url, "--data-folder", folder]);
    expect(join_.stderr).toBe("");
    expect(join_.status).toBe(0);
    expect(existsSync(join(folder, "README.md"))).toBe(true);
    const status = JSON.parse((await cli(pc, ["replication", "status", "--json"])).stdout);
    expect(status).toMatchObject({ status: "up_to_date", remote: remote.url });
  });

  it("says what to change when the repository address holds a token", async () => {
    const svc = await startTestService();
    services.push(svc);
    const r = await cli(svc, ["replication", "setup", "https://me:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/me/brain.git"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Leave the token out of the repository address");
    expect(r.stderr).not.toContain("ghp_");
  });
});
