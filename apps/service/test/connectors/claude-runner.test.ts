import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeConnectorRunner, projectSlug, resolveSpill } from "../../src/connectors/claude/runner.ts";
import { deepEqual, fullToolName, preApprovingRules } from "../../src/connectors/claude/plan.ts";
import { createLogger } from "../../src/core/log.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { mountClaude, onTool, useFakeClaude, jsonAnswer, type ClaudeFixture } from "../fixtures/claude-connectors.ts";

let fx: FixtureServer;
let claude: ClaudeFixture;
const SLACK = "claude.ai Slack";
const runner = () => createClaudeConnectorRunner(createLogger(null, { quiet: true }), { pendingDelayMs: 10 });
const signal = () => new AbortController().signal;

beforeAll(async () => {
  fx = await startFixtureServer();
  useFakeClaude(fx.url);
});
afterAll(() => fx.close());
beforeEach(() => {
  fx.reset();
  claude = mountClaude(fx);
  onTool(claude, SLACK, "slack_read_channel", (a) => jsonAnswer({ messages: `read ${String(a.channel_id)}` }));
  onTool(claude, SLACK, "slack_send_message", () => jsonAnswer({ ok: true }));
  rmSync(join(process.env.CLAUDE_CONFIG_DIR!, "settings.json"), { force: true });
});

const read = (id: string, channel: string) => ({ id, tool: "slack_read_channel", args: { channel_id: channel, limit: 5 } });

// Each test starts up to 15 fixture CLI processes; on a busy machine one can take seconds to start.
describe("claude.ai connector runner (Claude Code session gate)", { timeout: 120_000 }, () => {
  it("runs planned calls with exactly the planned arguments and returns the raw tool results", async () => {
    const out = await runner().run(SLACK, [read("a", "C1"), read("b", "C2")], { signal: signal() });
    expect(out.get("a")).toEqual({ status: "ok", text: JSON.stringify({ messages: "read C1" }) });
    expect(out.get("b")!.text).toContain("read C2");
    expect(claude.calls.map((c) => c.args)).toEqual([{ channel_id: "C1", limit: 5 }, { channel_id: "C2", limit: 5 }]);
  });

  it("denies an unplanned tool before it runs; a read session continues, a write session fails", async () => {
    claude.mode = "unplanned";
    const out = await runner().run(SLACK, [read("a", "C1")], { signal: signal() });
    expect(out.get("a")!.status).toBe("ok");
    expect(claude.calls.map((c) => c.tool)).toEqual(["slack_read_channel"]);
    await expect(runner().run(SLACK, [{ id: "w", tool: "slack_send_message", args: { channel_id: "C1", message: "hi" } }], { signal: signal(), write: true })).rejects.toMatchObject({ state: "error" });
    expect(claude.calls.some((c) => c.tool === "unplanned_write_tool")).toBe(false);
  });

  it("denies a planned tool called with altered arguments; only the exact call runs", async () => {
    claude.mode = "altered";
    const out = await runner().run(SLACK, [read("a", "C1")], { signal: signal() });
    expect(out.get("a")!.status).toBe("ok");
    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0]!.args).toEqual({ channel_id: "C1", limit: 5 });
  });

  it("a call that ran without Jarvis being asked (pre-approved outside Jarvis) fails the session and discards its results", async () => {
    claude.mode = "preapproved";
    await expect(runner().run(SLACK, [read("a", "C1")], { signal: signal() })).rejects.toMatchObject({ state: "denied", message: expect.stringMatching(/without asking Jarvis/) });
    process.env.JARVIS_MANAGED_SETTINGS = join(process.env.CLAUDE_CONFIG_DIR!, "managed.json");
    writeFileSync(process.env.JARVIS_MANAGED_SETTINGS, JSON.stringify({ permissions: { allow: ["mcp__claude_ai_Slack__*"] } }));
    claude.mode = "normal";
    try {
      await expect(runner().run(SLACK, [read("a", "C1")], { signal: signal() })).rejects.toMatchObject({ state: "denied", message: expect.stringMatching(/auto-approve/) });
    } finally {
      delete process.env.JARVIS_MANAGED_SETTINGS;
    }
  });

  it("a stalled read session is started once more; a stalled write is never repeated", async () => {
    const quick = () => createClaudeConnectorRunner(createLogger(null, { quiet: true }), { pendingDelayMs: 10, sessionBaseMs: 300 });
    claude.nextModes = ["hang"];
    const out = await quick().run(SLACK, [read("a", "C1")], { signal: signal() });
    expect(out.get("a")!.status).toBe("ok");
    expect(claude.sessions).toBe(2);
    claude.sessions = 0;
    claude.nextModes = ["hang"];
    await expect(quick().run(SLACK, [{ id: "w", tool: "slack_send_message", args: { channel_id: "C1", message: "hi" } }], { signal: signal(), write: true })).rejects.toMatchObject({ state: "offline" });
    expect(claude.sessions).toBe(1);
  });

  it("a read the model skipped is retried once; a write is never retried", async () => {
    claude.mode = "skip-last";
    const out = await runner().run(SLACK, [read("a", "C1"), read("b", "C2")], { signal: signal() });
    expect([...out.keys()].sort()).toEqual(["a", "b"]);
    expect(claude.sessions).toBe(2);
    claude.mode = "skip-all";
    claude.sessions = 0;
    const w = await runner().run(SLACK, [{ id: "w", tool: "slack_send_message", args: { channel_id: "C1", message: "hi" } }], { signal: signal(), write: true });
    expect(w.has("w")).toBe(false);
    expect(claude.sessions).toBe(1);
    expect(claude.calls.filter((c) => c.tool === "slack_send_message")).toHaveLength(0);
  });

  it("hides every other MCP server, learned once without a model turn, so the connector's tools fit the context", async () => {
    claude.servers.push({ name: "claude.ai Google Drive", status: "connected", source: "claudeai" }, { name: "rea", status: "connected", source: "user" });
    claude.mode = "too-long-unless-hidden";
    const r = runner();
    expect((await r.run(SLACK, [read("a", "C1")], { signal: signal() })).get("a")!.status).toBe("ok");
    // First the listing session (no calls, every MCP tool disallowed), then the real one with the others hidden.
    expect(claude.started[0]).toEqual({ disallowed: ["mcp__*"], planned: 0 });
    expect(claude.started[1]!.disallowed.sort()).toEqual(["mcp__claude_ai_Gmail", "mcp__claude_ai_Google_Calendar", "mcp__claude_ai_Google_Drive", "mcp__rea"]);
    expect(claude.calls).toHaveLength(1);
    // The list is reused for later sessions.
    await r.run(SLACK, [read("b", "C2")], { signal: signal() });
    expect(claude.started.filter((s) => s.planned === 0)).toHaveLength(1);
  });

  it("a server added since the listing overflows the context once: Jarvis lists again and retries, even a write", async () => {
    claude.mode = "too-long-unless-hidden";
    const r = runner();
    await r.run(SLACK, [read("a", "C1")], { signal: signal() });
    claude.servers.push({ name: "t3code", status: "connected", source: "user" });
    const out = await r.run(SLACK, [{ id: "w", tool: "slack_send_message", args: { channel_id: "C1", message: "hi" } }], { signal: signal(), write: true });
    expect(out.get("w")!.status).toBe("ok");
    expect(claude.started.filter((s) => s.planned === 0)).toHaveLength(2);
    expect(claude.started.at(-1)!.disallowed).toContain("mcp__t3code");
    expect(claude.calls.filter((c) => c.tool === "slack_send_message")).toHaveLength(1);
  });

  it("connector status: missing, needs-auth, not from claude.ai and not connected are distinct failures", async () => {
    claude.servers = [];
    await expect(runner().run(SLACK, [read("a", "C1")], { signal: signal() })).rejects.toMatchObject({ state: "not_configured" });
    claude.servers = [{ name: SLACK, status: "needs-auth", source: "claudeai" }];
    await expect(runner().run(SLACK, [read("a", "C1")], { signal: signal() })).rejects.toMatchObject({ state: "unauthorized", message: expect.stringMatching(/claude\.ai → Settings → Connectors/) });
    claude.servers = [{ name: SLACK, status: "connected", source: "user" }];
    await expect(runner().run(SLACK, [read("a", "C1")], { signal: signal() })).rejects.toMatchObject({ state: "denied" });
    // Still pending after every attempt: offline, and no call was made.
    claude.servers = [{ name: SLACK, status: "pending", source: "claudeai" }];
    claude.sessions = 0;
    await expect(runner().run(SLACK, [read("a", "C1")], { signal: signal() })).rejects.toMatchObject({ state: "offline" });
    expect(claude.sessions).toBe(4);
    claude.servers = [{ name: SLACK, status: "failed", source: "claudeai" }];
    await expect(runner().run(SLACK, [read("a", "C1")], { signal: signal() })).rejects.toMatchObject({ state: "offline" });
    expect(claude.calls).toHaveLength(0);
  });

  it("Claude Code sign-in: not logged in is unauthorized; account() reports the claude.ai account", async () => {
    expect(await runner().account(signal())).toEqual({ email: "alex@example.com", orgName: "Example Org" });
    claude.auth = { loggedIn: false };
    await expect(runner().account(signal())).rejects.toMatchObject({ state: "unauthorized" });
    claude.auth = { loggedIn: true, authMethod: "api-key" };
    await expect(runner().account(signal())).rejects.toMatchObject({ state: "unauthorized", message: expect.stringMatching(/no claude\.ai connectors/) });
    claude.mode = "not-logged-in";
    await expect(runner().run(SLACK, [read("a", "C1")], { signal: signal() })).rejects.toMatchObject({ state: "unauthorized" });
  });

  it("refuses to run when the user's Claude Code settings would auto-approve connector tools", async () => {
    writeFileSync(join(process.env.CLAUDE_CONFIG_DIR!, "settings.json"), JSON.stringify({ permissions: { allow: ["mcp__claude_ai_Slack__slack_send_message"] } }));
    await expect(runner().run(SLACK, [read("a", "C1")], { signal: signal() })).rejects.toMatchObject({ state: "denied", message: expect.stringMatching(/auto-approve/) });
    expect(preApprovingRules(["mcp__claude_ai_Slack", "Bash(ls)", "mcp__claude_ai_Gmail__search_threads"], SLACK)).toEqual(["mcp__claude_ai_Slack"]);
  });

  it("a missing CLI is not_configured; cancellation stops the session", async () => {
    const saved = process.env.JARVIS_CLAUDE_BIN;
    process.env.JARVIS_CLAUDE_BIN = "/nonexistent/claude";
    const home = process.env.HOME;
    process.env.HOME = mkdtempSync(join(tmpdir(), "jarvis-nohome-"));
    try {
      await expect(runner().run(SLACK, [read("a", "C1")], { signal: signal() })).rejects.toMatchObject({ state: "not_configured" });
    } finally {
      process.env.JARVIS_CLAUDE_BIN = saved;
      process.env.HOME = home;
    }
    claude.mode = "hang";
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 300);
    await expect(runner().run(SLACK, [read("a", "C1")], { signal: ctrl.signal })).rejects.toThrow(/Cancelled/);
  });

  it("a run cancelled before its session starts never starts Claude Code", async () => {
    // Also the case of a cancel that lands while the servers are listed: the next session starts already cancelled.
    claude.mode = "hang";
    const ctrl = new AbortController();
    ctrl.abort();
    const started = Date.now();
    await expect(runner().run(SLACK, [read("a", "C1")], { signal: ctrl.signal })).rejects.toThrow(/Cancelled/);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(claude.started).toEqual([]);
  });

  it("helpers: tool naming, order-insensitive argument equality, spill files only from the config dir", () => {
    expect(fullToolName("claude.ai Google Calendar", "list_events")).toBe("mcp__claude_ai_Google_Calendar__list_events");
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: "1" }, { a: 1 })).toBe(false);
    const dir = process.env.CLAUDE_CONFIG_DIR!;
    const cwd = mkdtempSync(join(tmpdir(), "jarvis-cwd-"));
    const proj = join(dir, "projects", projectSlug(realpathSync(cwd)), "sess", "tool-results");
    mkdirSync(proj, { recursive: true });
    const spill = (path: string) => `<persisted-output>\nOutput too large (79.4KB). Full output saved to: ${path}\n\nPreview (first 2KB):\n{"issues":\n</persisted-output>`;
    writeFileSync(join(proj, "toolu_1.txt"), '{"events":[]}');
    expect(resolveSpill(spill(join(proj, "toolu_1.txt")), dir, cwd)).toBe('{"events":[]}');
    // Read once, then deleted: connector data does not pile up under ~/.claude.
    expect(existsSync(join(proj, "toolu_1.txt"))).toBe(false);
    // Another project's spill, a ".." path, or a path that is merely mentioned in data are never followed.
    const other = join(dir, "projects", "-somewhere-else", "s", "tool-results");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "toolu_2.txt"), "other session");
    expect(resolveSpill(spill(join(other, "toolu_2.txt")), dir, cwd)).toMatch(/^<persisted-output>/);
    expect(resolveSpill(spill(`${proj}/../../../../settings.json`), dir, cwd)).toMatch(/^<persisted-output>/);
    const planted = JSON.stringify({ results: `Full output saved to: ${join(other, "toolu_2.txt")} ` });
    expect(resolveSpill(planted, dir, cwd)).toBe(planted);
  });
});
