import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { startTestService, type TestService } from "./harness.ts";
import { callTool, mcpClients } from "./mcp-client.ts";
import { currentOs } from "../../src/platform/os.ts";
import { harnessMcpConfigs } from "../../src/platform/harness-locations.ts";

const HOME = process.env.JARVIS_AGENT_HOME!;
const MCP = harnessMcpConfigs(currentOs());
const at = (...rel: string[]) => join(HOME, ...rel);
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const write = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

const CLAUDE_JSON = { numStartups: 12, projects: { "/work/api": { allowedTools: [] } }, mcpServers: { granola: { type: "http", url: "https://mcp.example.com/mcp" } } };
const CODEX_TOML = `# My Codex settings
model = "gpt-5"

[mcp_servers.rea]
command = "rea"
args = ["serve"]

[mcp_servers.rea.env]
REA_HOME = "/opt/rea"

# Railway, added by hand
[mcp_servers.railway]
command = "npx"
args = ["-y", "@railway/mcp-server"]
`;
const ANTIGRAVITY_MCP = { mcpServers: { rea: { command: "rea", args: ["serve"], env: {} } } };
const DESKTOP_CONFIG = { preferences: { sidebarMode: "chat" }, coworkUserFilesPath: "/Users/owner/Cowork" };

let svc: TestService;
let stateDir: string;
const mcp = mcpClients();

/** The MCP server entry Jarvis registered in a JSON config, by the name Jarvis gave it. */
function registered(file: string): { name: string; command: string; args: string[] } {
  const servers = readJson(file).mcpServers as Record<string, { command: string; args: string[] }>;
  const [name, entry] = Object.entries(servers).find(([, e]) => Array.isArray(e.args) && e.args.includes("mcp") && e.args.includes(stateDir)) ?? [];
  if (!name || !entry) throw new Error(`no Jarvis MCP server in ${file}`);
  return { name, ...entry };
}

/** A skill folder an earlier version of Jarvis installed, with its marker. */
function legacySkill(folder: string, markerStateDir: string) {
  write(join(folder, "SKILL.md"), "---\nname: jarvis-save\ndisable-model-invocation: true\n---\nRun jarvis save.\n");
  write(join(folder, ".jarvis-skill.json"), JSON.stringify({ managedBy: "jarvis", stateDir: markerStateDir, agents: ["claude-code", "codex"] }));
}

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "jarvis-it-state-"));
  write(at(".claude/settings.json"), JSON.stringify({ model: "opus" }, null, 2));
  write(at(".claude.json"), JSON.stringify(CLAUDE_JSON, null, 2));
  write(at(".codex/config.toml"), CODEX_TOML);
  write(at(".gemini/config/mcp_config.json"), JSON.stringify(ANTIGRAVITY_MCP, null, 2));
  // The Antigravity command-line tool, as this operating system names an executable.
  write(at(".local/bin", process.platform === "win32" ? "agy.exe" : "agy"), "");
  write(at(MCP["claude-desktop"].file), JSON.stringify(DESKTOP_CONFIG, null, 2));
  // What an earlier version left: its save and audit skills, another install's skill, and skills of the owner's own.
  legacySkill(at(".claude/skills/jarvis-save"), stateDir);
  legacySkill(at(".claude/skills/jarvis-audit"), stateDir);
  legacySkill(at(".agents/skills/jarvis-save"), stateDir);
  legacySkill(at(".gemini/config/skills/jarvis-audit"), stateDir);
  legacySkill(at(".claude/skills/jarvis-other-save"), "/another/jarvis/state");
  write(at(".claude/skills/my-save/SKILL.md"), "---\nname: my-save\n---\nMine.\n");
  write(at(".agents/skills/jarvis-notes/SKILL.md"), "---\nname: jarvis-notes\n---\nNamed like Jarvis, but mine.\n");
  svc = await startTestService({ stateDir });
  await svc.post("/setup/identity", { name: "Ada Lovelace", email: "ada@example.com", confirm: true });
  await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned for the first weekend of December" }] }] });
});
afterAll(async () => {
  await mcp.closeAll();
  await svc?.stop();
});

describe("after an upgrade", () => {
  it("removes the save and audit skill folders that carry this install's marker, and nothing else", () => {
    expect(readdirSync(at(".claude/skills")).sort()).toEqual(["jarvis-other-save", "my-save"]);
    expect(readdirSync(at(".agents/skills"))).toEqual(["jarvis-notes"]);
    expect(readdirSync(at(".gemini/config/skills"))).toEqual([]);
    expect(readFileSync(at(".claude/skills/my-save/SKILL.md"), "utf8")).toContain("Mine.");
  });
});

describe("connecting a Harness", () => {
  it("Claude Code gets the MCP server in ~/.claude.json and the hooks, with every other entry kept and the files backed up", async () => {
    const r = await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    expect(r.test.ok).toBe(true);
    expect(r.test.message).toMatch(/3 Jarvis hooks in .*settings\.json and Jarvis's MCP server in .*\.claude\.json/);
    const after = readJson(at(".claude.json"));
    expect(after.numStartups).toBe(12);
    expect(after.projects).toEqual(CLAUDE_JSON.projects);
    expect(after.mcpServers.granola).toEqual(CLAUDE_JSON.mcpServers.granola);
    expect(Object.keys(after.mcpServers)).toHaveLength(2);
    expect(JSON.stringify(readJson(at(".claude/settings.json")).hooks.SessionStart)).toContain("jarvis-agent-hook");
    expect(readdirSync(svc.app.paths.backupsDir).some((f) => f.includes("claude_json"))).toBe(true);
    expect(existsSync(at(".claude/skills/jarvis-save"))).toBe(false);
  });

  it("the registered server, started the way the Harness starts it, reaches the Brain", async () => {
    const entry = registered(at(".claude.json"));
    expect(entry.name).toMatch(/^jarvis(-[0-9a-f]{8})?$/);
    const client = await mcp.connectRegistered(entry, { name: "claude-code" });
    const r = await callTool<{ passages: Array<{ title: string }> }>(client, "search", { query: "Orion cutover" });
    expect(r.isError).toBe(false);
    expect(r.data.passages[0]!.title).toBe("Orion migration");
  });

  it("connecting again changes nothing", async () => {
    const before = readFileSync(at(".claude.json"), "utf8");
    const backups = readdirSync(svc.app.paths.backupsDir).length;
    await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    expect(readFileSync(at(".claude.json"), "utf8")).toBe(before);
    expect(readdirSync(svc.app.paths.backupsDir)).toHaveLength(backups);
  });

  it("Codex gets its own table in config.toml; comments, formatting and other servers stay as they were", async () => {
    const r = await svc.post("/connections/codex/configure", { method: "hooks", fields: {} });
    expect(r.test.ok).toBe(true);
    const text = readFileSync(at(".codex/config.toml"), "utf8");
    expect(text.startsWith(CODEX_TOML)).toBe(true);
    const servers = parseToml(text).mcp_servers as Record<string, { command: string; args: string[] }>;
    expect(Object.keys(servers).sort()).toEqual([registered(at(".claude.json")).name, "railway", "rea"].sort());
    expect(Object.values(servers).find((s) => s.args.includes(stateDir))).toMatchObject({ args: expect.arrayContaining(["mcp", "--state-dir", stateDir]) });
    expect(readJson(at(".codex/hooks.json")).hooks.SessionEnd).toBeDefined();
  });

  it("Antigravity gets the MCP server in ~/.gemini/config/mcp_config.json", async () => {
    const r = await svc.post("/connections/antigravity/configure", { method: "hooks", fields: {} });
    expect(r.test.ok).toBe(true);
    const after = readJson(at(".gemini/config/mcp_config.json"));
    expect(after.mcpServers.rea).toEqual(ANTIGRAVITY_MCP.mcpServers.rea);
    expect(registered(at(".gemini/config/mcp_config.json")).args).toContain("mcp");
  });

  it("Claude Desktop can be connected and gets the MCP server only", async () => {
    const definitions = (await svc.get("/capabilities")).definitions as Array<{ kind: string; label: string }>;
    expect(definitions.find((d) => d.kind === "claude-desktop")?.label).toBe("Claude Desktop");
    const r = await svc.post("/connections/claude-desktop/configure", { method: "mcp", fields: {} });
    expect(r.test.ok).toBe(true);
    expect(r.test.message).toContain("Jarvis's MCP server in");
    const after = readJson(at(MCP["claude-desktop"].file));
    expect(after.preferences).toEqual(DESKTOP_CONFIG.preferences);
    expect(after.coworkUserFilesPath).toBe(DESKTOP_CONFIG.coworkUserFilesPath);
    const entry = registered(at(MCP["claude-desktop"].file));
    const client = await mcp.connectRegistered(entry, { name: "claude-ai" });
    expect((await callTool<{ passages: unknown[] }>(client, "search", { query: "Orion" })).data.passages.length).toBeGreaterThan(0);
  });

  it("refuses a file it cannot parse, and changes nothing", async () => {
    await svc.post("/connections/codex/disconnect", { deleteData: false });
    const hooksBefore = readFileSync(at(".codex/hooks.json"), "utf8");
    const broken = `${CODEX_TOML}\n[mcp_servers.rea]\ncommand = "twice"\n`;
    write(at(".codex/config.toml"), broken);
    const r = await svc.call("POST", "/connections/codex/configure", { method: "hooks", fields: {} });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r.body)).toMatch(/config\.toml is not valid TOML.*Jarvis will not change it/);
    expect(readFileSync(at(".codex/config.toml"), "utf8")).toBe(broken);
    expect(readFileSync(at(".codex/hooks.json"), "utf8")).toBe(hooksBefore);
    write(at(".codex/config.toml"), CODEX_TOML);
  });

  it("refuses to replace an MCP server entry under Jarvis's name that Jarvis did not add", async () => {
    await svc.post("/connections/claude-desktop/disconnect", { deleteData: false });
    const name = registered(at(".claude.json")).name;
    const mine = { ...DESKTOP_CONFIG, mcpServers: { [name]: { command: "/usr/local/bin/my-own-server", args: [] } } };
    write(at(MCP["claude-desktop"].file), JSON.stringify(mine));
    const r = await svc.call("POST", "/connections/claude-desktop/configure", { method: "mcp", fields: {} });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r.body)).toContain(`already has an MCP server named \\"${name}\\" that Jarvis did not add`);
    expect(readJson(at(MCP["claude-desktop"].file))).toEqual(mine);
    write(at(MCP["claude-desktop"].file), JSON.stringify(DESKTOP_CONFIG, null, 2));
  });
});

describe("disconnecting a Harness", () => {
  it("removes the MCP server and the hooks, and only those", async () => {
    await svc.post("/connections/codex/configure", { method: "hooks", fields: {} });
    await svc.post("/connections/claude-desktop/configure", { method: "mcp", fields: {} });
    for (const k of ["claude-code", "codex", "antigravity", "claude-desktop"]) await svc.post(`/connections/${k}/disconnect`, { deleteData: false });
    expect(readJson(at(".claude.json"))).toEqual(CLAUDE_JSON);
    expect(readJson(at(".claude/settings.json"))).toEqual({ model: "opus", hooks: {} });
    expect(readFileSync(at(".codex/config.toml"), "utf8")).toBe(CODEX_TOML);
    expect(readJson(at(".gemini/config/mcp_config.json"))).toEqual(ANTIGRAVITY_MCP);
    expect(readJson(at(MCP["claude-desktop"].file))).toEqual(DESKTOP_CONFIG);
  });
});
