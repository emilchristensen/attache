import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spoolText } from "../../src/agents/spool.ts";
import { startTestService, type TestService } from "./harness.ts";

/**
 * Pi, OpenCode and Copilot CLI follow the same lifecycle as the Harnesses
 * that came before them: an Attache upgrade brings their files up to date
 * when the service starts, and turning Agent sessions off disconnects them.
 */

const HOME = process.env.ATTACHE_AGENT_HOME!;
const at = (...rel: string[]) => join(HOME, ...rel);
const KINDS = ["pi", "opencode", "copilot-cli"] as const;

interface Status {
  kind?: string;
  status: string;
  lastError?: string | null;
  harness?: { state: string; message: string; files: string[] };
}

let svc: TestService;
const connection = async (kind: string) => (await svc.get<Status[]>("/connections")).find((s) => s.kind === kind)!;
const until = async (check: () => boolean | Promise<boolean>, timeoutMs = 10_000) => {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

beforeAll(async () => {
  // Never run or find a real OpenCode or Copilot CLI.
  process.env.ATTACHE_OPENCODE_BIN = at("no-opencode-here");
  process.env.ATTACHE_COPILOT_BIN = at("no-copilot-here");
  svc = await startTestService();
});
afterAll(async () => {
  delete process.env.ATTACHE_OPENCODE_BIN;
  delete process.env.ATTACHE_COPILOT_BIN;
  await svc?.stop();
});

describe("Pi, OpenCode and Copilot CLI across an Attache upgrade", () => {
  it("files an earlier Attache left out of date are brought up to date when Attache starts", async () => {
    for (const kind of KINDS) {
      await svc.post(`/connections/${kind}/configure`, { method: "mcp", fields: {} });
      expect((await connection(kind)).harness?.state).toBe("current");
    }
    // What an earlier version wrote differs from what this version writes, as after an upgrade that moved the install.
    for (const kind of KINDS) for (const file of (await connection(kind)).harness!.files) appendFileSync(file, "\n");
    for (const kind of KINDS) expect((await connection(kind)).harness?.state, kind).toBe("stale");
    // The owner can learn the plugin is stale by clicking Test before the next service restart.
    expect((await svc.post<{ test: { ok: boolean } }>("/connections/opencode/test", {})).test.ok).toBe(false);
    expect((await connection("opencode")).status).toBe("error");
    const { stateDir, dataDir } = svc;
    await svc.stop();
    spoolText(stateDir, { agent: "opencode", event: "pre-compact", sessionId: "old-plugin-format", cwd: null }, JSON.stringify({
      attache: "opencode-session", v: 1, opencode: 2, shape: "v2-request", sessionID: "old-plugin-format", messages: [],
    }));
    svc = await startTestService({ stateDir, dataDir });
    for (const kind of KINDS) expect((await connection(kind)).harness?.state, kind).toBe("current");
    await until(async () => (await connection("opencode")).status === "connected");
    expect((await connection("opencode")).lastError).toMatch(/could not read an? OpenCode session.*Restart OpenCode/i);
  });
});

describe("turning Agent sessions off", () => {
  it("disconnects the three Harnesses even when the last configuration test failed", async () => {
    for (const kind of KINDS) await svc.post(`/connections/${kind}/configure`, { method: "mcp", fields: {} });
    const [openCodePlugin] = (await connection("opencode")).harness!.files;
    expect(existsSync(openCodePlugin!)).toBe(true);
    appendFileSync(openCodePlugin!, "\n");
    expect((await svc.post<{ test: { ok: boolean } }>("/connections/opencode/test", {})).test.ok).toBe(false);
    expect((await connection("opencode")).status).toBe("error");
    await svc.put("/features", { changes: { sessions: false }, cascade: true });
    for (const kind of KINDS) await until(async () => (await connection(kind)).status === "disconnected");
    expect(readdirSync(at(".pi/agent/extensions")).filter((f) => f.startsWith("attache"))).toEqual([]);
    expect(existsSync(openCodePlugin!)).toBe(false);
    expect(existsSync(at(".copilot/hooks")) ? readdirSync(at(".copilot/hooks")) : []).toEqual([]);
    await svc.put("/features", { changes: { sessions: true }, cascade: true });
    for (const kind of KINDS) expect((await connection(kind)).status).toBe("disconnected");
  });
});
