import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { currentOs } from "../../src/platform/os.ts";
import { harnessMcpConfigs } from "../../src/platform/harness-locations.ts";

/**
 * The Harness Connection flow (ADR 0006) through the service's public routes: preview before connecting,
 * connect, status, reconnect as refresh, and disconnect, for the existing Harnesses behind the adapter boundary.
 */

const HOME = process.env.ATTACHE_AGENT_HOME!;
const MCP = harnessMcpConfigs(currentOs());
const at = (...rel: string[]) => join(HOME, ...rel);
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const write = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

const CLAUDE_SETTINGS = { model: "opus", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }] } };
const CLAUDE_JSON = { numStartups: 3, mcpServers: { granola: { type: "http", url: "https://mcp.example.com/mcp" } } };
const DESKTOP_CONFIG = { preferences: { sidebarMode: "chat" } };

let svc: TestService;
let stateDir: string;

interface Change {
  path: string;
  change: string;
  backup: boolean;
  purpose: string;
}

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "attache-it-flow-state-"));
  write(at(".claude/settings.json"), JSON.stringify(CLAUDE_SETTINGS, null, 2));
  write(at(".claude.json"), JSON.stringify(CLAUDE_JSON, null, 2));
  mkdirSync(at(".codex"), { recursive: true });
  write(at(MCP["claude-desktop"].file), JSON.stringify(DESKTOP_CONFIG, null, 2));
  svc = await startTestService({ stateDir });
});
afterAll(async () => {
  await svc?.stop();
});

describe("previewing a Harness Connection", () => {
  it("lists every file connecting would change, says which are backed up, and writes nothing", async () => {
    const before = readFileSync(at(".claude.json"), "utf8");
    const p = await svc.get<{ changes: Change[]; restartRequired: boolean; capabilities: { mcp: boolean; memory: string; capture: string } }>("/connections/claude-code/harness-preview");
    expect(p.changes.map((c) => [c.path, c.change, c.backup])).toEqual([
      [at(".claude/settings.json"), "update", true],
      [at(".claude.json"), "update", true],
    ]);
    expect(p.changes.every((c) => c.purpose.length > 0)).toBe(true);
    expect(p.restartRequired).toBe(false);
    expect(p.capabilities).toEqual({ mcp: true, memory: "runtime-fresh", capture: "with-final-event" });
    expect(readFileSync(at(".claude.json"), "utf8")).toBe(before);
    expect(readJson(at(".claude/settings.json"))).toEqual(CLAUDE_SETTINGS);
  });
});

describe("a file Attache cannot safely parse", () => {
  it("stops the preview and the connection before any related file changes, and names the file", async () => {
    const broken = '{ "model": "opus", // my comment\n}';
    write(at(".claude/settings.json"), broken);
    const claudeJson = readFileSync(at(".claude.json"), "utf8");
    const p = await svc.call("GET", "/connections/claude-code/harness-preview");
    expect(p.status).toBe(409);
    expect(JSON.stringify(p.body)).toContain("settings.json");
    const r = await svc.call("POST", "/connections/claude-code/configure", { method: "hooks", fields: {} });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r.body)).toContain("settings.json");
    expect(readFileSync(at(".claude/settings.json"), "utf8")).toBe(broken);
    expect(readFileSync(at(".claude.json"), "utf8")).toBe(claudeJson);
    write(at(".claude/settings.json"), JSON.stringify(CLAUDE_SETTINGS, null, 2));
  });
});

interface Status {
  status: string;
  lastError: string | null;
  harness?: { state: string; message: string; files: string[] };
}
const connection = async (kind: string) => ((await svc.get<Status[]>("/connections")).find((s) => (s as { kind?: string }).kind === kind) as Status | undefined)!;
const backups = () => readdirSync(svc.app.paths.backupsDir);
/** Attache's hook commands in Claude Code's settings, in file order. */
const attacheGroups = (settings: { hooks: Record<string, Array<{ hooks: Array<{ command: string; timeout?: number }> }>> }) =>
  Object.values(settings.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks)).filter((h) => h.command.includes("attache-agent-hook"));

describe("connecting, checking and reconnecting a Harness", () => {
  it("connects, reports the Connection current, and keeps a backup of each changed file that holds its old content", async () => {
    const r = await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    expect(r.test.ok).toBe(true);
    const s = await connection("claude-code");
    expect(s.harness?.state).toBe("current");
    expect(s.harness?.files).toEqual([at(".claude/settings.json"), at(".claude.json")]);
    const settings = readJson(at(".claude/settings.json"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks.PreToolUse).toEqual(CLAUDE_SETTINGS.hooks.PreToolUse);
    const restored = backups().map((f) => readFileSync(join(svc.app.paths.backupsDir, f), "utf8"));
    expect(restored).toContain(JSON.stringify(CLAUDE_SETTINGS, null, 2));
    expect(restored).toContain(JSON.stringify(CLAUDE_JSON, null, 2));
  });

  it("reports stale when Attache's entries are there but out of date, and reconnecting repairs only those", async () => {
    const settings = readJson(at(".claude/settings.json"));
    attacheGroups(settings)[0]!.timeout = 999;
    write(at(".claude/settings.json"), JSON.stringify(settings, null, 2));
    expect((await connection("claude-code")).harness?.state).toBe("stale");
    const test = await svc.post<{ test: { ok: boolean }; status: Status }>("/connections/claude-code/test");
    expect(test.status.harness?.state).toBe("stale");
    expect(test.status.status).toBe("error");
    await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    const repaired = readJson(at(".claude/settings.json"));
    expect(attacheGroups(repaired).map((h) => h.timeout)).not.toContain(999);
    expect(attacheGroups(repaired)).toHaveLength(3);
    expect(repaired.hooks.PreToolUse).toEqual(CLAUDE_SETTINGS.hooks.PreToolUse);
    expect((await connection("claude-code")).harness?.state).toBe("current");
  });

  it("connecting again when current changes no file and makes no backup", async () => {
    const files = [readFileSync(at(".claude/settings.json"), "utf8"), readFileSync(at(".claude.json"), "utf8")];
    const n = backups().length;
    const p = await svc.get<{ changes: Change[] }>("/connections/claude-code/harness-preview");
    expect(p.changes).toEqual([]);
    await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    expect([readFileSync(at(".claude/settings.json"), "utf8"), readFileSync(at(".claude.json"), "utf8")]).toEqual(files);
    expect(backups()).toHaveLength(n);
  });

  it("reports missing when part of Attache's entries are gone", async () => {
    const saved = readFileSync(at(".claude.json"), "utf8");
    write(at(".claude.json"), JSON.stringify(CLAUDE_JSON, null, 2));
    const s = await connection("claude-code");
    expect(s.harness?.state).toBe("missing");
    expect(s.harness?.message).toContain(".claude.json");
    write(at(".claude.json"), saved);
  });

  it("reports failed, naming the file, when a file cannot be parsed", async () => {
    const saved = readFileSync(at(".claude/settings.json"), "utf8");
    write(at(".claude/settings.json"), "{ not json");
    const s = await connection("claude-code");
    expect(s.harness?.state).toBe("failed");
    expect(s.harness?.message).toContain("settings.json");
    write(at(".claude/settings.json"), saved);
  });

  it("an MCP-only Harness that must be restarted says so before and after connecting", async () => {
    const defs = (await svc.get<{ definitions: Array<{ kind: string; harness?: { restartRequired: boolean; capabilities: unknown } }> }>("/capabilities")).definitions;
    expect(defs.find((d) => d.kind === "claude-desktop")?.harness).toEqual({ restartRequired: true, capabilities: { mcp: true, memory: "none", capture: "none" } });
    const p = await svc.get<{ changes: Change[]; restartRequired: boolean }>("/connections/claude-desktop/harness-preview");
    expect(p.restartRequired).toBe(true);
    expect(p.changes.map((c) => c.path)).toEqual([at(MCP["claude-desktop"].file)]);
    await svc.post("/connections/claude-desktop/configure", { method: "mcp", fields: {} });
    expect((await connection("claude-desktop")).harness?.state).toBe("current");
  });
});

describe("disconnecting a Harness", () => {
  const OTHER_STATE = "/srv/other attache/state";
  const otherHook = { type: "command", command: `node /opt/attache/attache-agent-hook.mjs claude-code session-start --state-dir "${OTHER_STATE}"`, timeout: 10 };
  const otherServer = { command: "attache", args: ["mcp", "--state-dir", OTHER_STATE] };

  it("removes only this instance's entries, keeps the owner's and another Attache instance's, and says what it removed", async () => {
    const settings = readJson(at(".claude/settings.json"));
    settings.hooks.SessionStart.push({ matcher: "", hooks: [otherHook] });
    write(at(".claude/settings.json"), JSON.stringify(settings, null, 2));
    const claudeJson = readJson(at(".claude.json"));
    claudeJson.mcpServers["attache-0ther000"] = otherServer;
    write(at(".claude.json"), JSON.stringify(claudeJson, null, 2));
    expect((await connection("claude-code")).harness?.state).toBe("current");

    const r = await svc.post<{ harness: { removed: Change[]; failures: string[] } }>("/connections/claude-code/disconnect", { deleteData: false });
    expect(r.harness.failures).toEqual([]);
    expect(r.harness.removed.map((c) => c.path).sort()).toEqual([at(".claude.json"), at(".claude/settings.json")].sort());
    expect(readJson(at(".claude.json"))).toEqual({ ...CLAUDE_JSON, mcpServers: { ...CLAUDE_JSON.mcpServers, "attache-0ther000": otherServer } });
    const after = readJson(at(".claude/settings.json"));
    expect(after.model).toBe("opus");
    expect(after.hooks.PreToolUse).toEqual(CLAUDE_SETTINGS.hooks.PreToolUse);
    expect(after.hooks.SessionStart).toEqual([{ matcher: "", hooks: [otherHook] }]);
  });

  it("a partial failure still removes every other part, and names the file whose entries remain", async () => {
    write(at(".claude/settings.json"), JSON.stringify(CLAUDE_SETTINGS, null, 2));
    await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    const settings = readFileSync(at(".claude/settings.json"), "utf8");
    write(at(".claude/settings.json"), `${settings}\n// added by hand`);
    const r = await svc.post<{ harness: { removed: Change[]; failures: string[] } }>("/connections/claude-code/disconnect", { deleteData: false });
    expect(r.harness.removed.map((c) => c.path)).toEqual([at(".claude.json")]);
    expect(r.harness.failures).toHaveLength(1);
    expect(r.harness.failures[0]).toContain(at(".claude/settings.json"));
    expect(JSON.stringify(readJson(at(".claude.json")))).not.toContain(stateDir);
    expect(readFileSync(at(".claude/settings.json"), "utf8")).toContain("attache-agent-hook");
    const s = await connection("claude-code");
    expect(s.status).toBe("disconnected");
    expect(s.lastError).toContain(at(".claude/settings.json"));
  });
});
