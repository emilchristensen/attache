import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { callTool, mcpClients } from "./mcp-client.ts";

/**
 * OpenCode as a Harness Connection through the service's public routes: preview, connect without
 * OpenCode having been found, the registered MCP server reaching the Brain, refusing a broken
 * configuration, status and disconnect.
 */

const HOME = process.env.ATTACHE_AGENT_HOME!;
const at = (...rel: string[]) => join(HOME, ...rel);
const CONFIG = at(".config/opencode");
const PLUGINS = join(CONFIG, "plugins");
const OWN_CONFIG = '{\n  // the owner\'s own\n  "mcp": { "files": { "type": "local", "command": ["npx", "fs"] } },\n}\n';
const write = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

let svc: TestService;
const mcp = mcpClients();

interface Status {
  kind?: string;
  status: string;
  last_error?: string | null;
  harness?: { state: string; message: string; files: string[] };
}
const connection = async () => (await svc.get<Status[]>("/connections")).find((s) => s.kind === "opencode")!;

/** The MCP server Attache's plugin registers when OpenCode 1 loads it (its `config` hook), as an MCP client starts it. */
async function registeredByPlugin(): Promise<{ command: string; args: string[] }> {
  const [file] = readdirSync(PLUGINS).filter((f) => f.startsWith("attache"));
  const mod = (await import(`${join(PLUGINS, file!)}?v=${Math.random()}`)) as { default: { server: () => Promise<{ config: (c: { mcp?: Record<string, { command: string[] }> }) => Promise<void> }> } };
  const config: { mcp?: Record<string, { command: string[] }> } = {};
  await (await mod.default.server()).config(config);
  const [command, ...args] = Object.values(config.mcp!)[0]!.command;
  return { command: command!, args };
}

beforeAll(async () => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.OPENCODE_CONFIG;
  // OpenCode is not in any folder Attache looks in; the owner's own plugin and configuration are.
  process.env.ATTACHE_OPENCODE_BIN = at("no-opencode-here");
  write(join(PLUGINS, "mine.js"), "export default { id: 'mine', setup() {} };\n");
  write(join(CONFIG, "opencode.jsonc"), OWN_CONFIG);
  svc = await startTestService({ stateDir: mkdtempSync(join(tmpdir(), "attache-it-opencode-state-")) });
  await svc.post("/setup/identity", { name: "Ada Lovelace", email: "ada@example.com", confirm: true });
  await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned for the first weekend of December" }] }] });
});
afterAll(async () => {
  await mcp.closeAll();
  await svc?.stop();
  delete process.env.ATTACHE_OPENCODE_BIN;
});

describe("OpenCode as a Harness Connection", () => {
  it("is its own Connection that reports MCP access only and that a running OpenCode must restart", async () => {
    const defs = (await svc.get<{ definitions: Array<{ kind: string; label: string; harness?: unknown; authMethods: Array<{ id: string }> }> }>("/capabilities")).definitions;
    expect(defs.find((d) => d.kind === "opencode")).toMatchObject({ label: "OpenCode", authMethods: [{ id: "mcp" }], harness: { restartRequired: true, capabilities: { mcp: true, memory: "none", capture: "none" } } });
    expect((await connection()).status).not.toBe("connected");
  });

  it("previews the one plugin file connecting would create", async () => {
    const p = await svc.get<{ changes: Array<{ path: string; change: string; backup: boolean }>; restartRequired: boolean }>("/connections/opencode/harness-preview");
    expect(p.restartRequired).toBe(true);
    expect(p.changes).toEqual([expect.objectContaining({ change: "create", backup: false, path: expect.stringContaining(PLUGINS) })]);
    expect(readdirSync(PLUGINS)).toEqual(["mine.js"]);
  });

  it("refuses to preview over a configuration file that does not parse, naming it, and writes nothing", async () => {
    write(join(CONFIG, "opencode.json"), "{ nope");
    const r = await svc.call("GET", "/connections/opencode/harness-preview");
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/opencode\.json is not valid JSON/);
    const c = await svc.call("POST", "/connections/opencode/configure", { method: "mcp", fields: {} });
    expect(c.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(c.body)).toMatch(/opencode\.json is not valid JSON/);
    expect(readdirSync(PLUGINS)).toEqual(["mine.js"]);
    write(join(CONFIG, "opencode.json"), "{}");
  });

  it("connects even though OpenCode was not found, and reports the Connection current", async () => {
    const r = await svc.post<{ test: { ok: boolean } }>("/connections/opencode/configure", { method: "mcp", fields: {} });
    expect(r.test.ok).toBe(true);
    expect((await connection()).harness?.state).toBe("current");
    expect(readdirSync(PLUGINS).sort()).toEqual([expect.stringMatching(/^attache(-[0-9a-f]{8})?\.js$/), "mine.js"]);
    expect(readFileSync(join(CONFIG, "opencode.jsonc"), "utf8")).toBe(OWN_CONFIG);
  });

  it("the server the plugin registers, started as OpenCode starts it, reaches the Brain", async () => {
    const client = await mcp.connectRegistered(await registeredByPlugin(), { name: "opencode" });
    const r = await callTool<{ passages: Array<{ title: string }> }>(client, "search", { query: "Orion cutover" });
    expect(r.isError).toBe(false);
    expect(r.data.passages[0]!.title).toBe("Orion migration");
  });

  it("disconnecting removes Attache's plugin only, and says what it removed", async () => {
    const r = await svc.post<{ harness: { removed: Array<{ path: string; change: string }>; failures: string[] } }>("/connections/opencode/disconnect", { deleteData: false });
    expect(r.harness.failures).toEqual([]);
    expect(r.harness.removed).toEqual([expect.objectContaining({ change: "remove", path: expect.stringContaining(PLUGINS) })]);
    expect(readdirSync(PLUGINS)).toEqual(["mine.js"]);
    expect(readFileSync(join(CONFIG, "opencode.jsonc"), "utf8")).toBe(OWN_CONFIG);
  });
});

describe("uninstalling Attache", () => {
  it("the uninstaller's agent-hooks uninstall also removes Attache's OpenCode plugin, and nothing else of OpenCode's", async () => {
    await svc.post("/connections/opencode/configure", { method: "mcp", fields: {} });
    expect(readdirSync(PLUGINS)).toHaveLength(2);
    const main = join(import.meta.dirname, "../../src/main.ts");
    const status = JSON.parse(execFileSync(process.execPath, [main, "agent-hooks", "status", "--agent", "opencode", "--state-dir", svc.stateDir], { encoding: "utf8", env: { ...process.env, ATTACHE_AGENT_HOME: HOME } })) as Array<{ agent: string; state?: string }>;
    expect(status).toEqual([expect.objectContaining({ agent: "opencode", state: "current" })]);
    const out = JSON.parse(execFileSync(process.execPath, [main, "agent-hooks", "uninstall", "--state-dir", svc.stateDir], { encoding: "utf8", env: { ...process.env, ATTACHE_AGENT_HOME: HOME } })) as Array<{ agent: string; error?: string }>;
    expect(out.find((r) => r.agent === "opencode")).toMatchObject({ agent: "opencode", removed: 1 });
    expect(readdirSync(PLUGINS)).toEqual(["mine.js"]);
  });
});
