import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const mod = (await import(`${join(PLUGINS, file!)}?v=${Math.random()}`)) as { default: { server: (input: { directory: string }) => Promise<{ config: (c: { mcp?: Record<string, { command: string[] }> }) => Promise<void> }> } };
  const config: { mcp?: Record<string, { command: string[] }> } = {};
  await (await mod.default.server({ directory: HOME })).config(config);
  const [command, ...args] = Object.values(config.mcp!)[0]!.command;
  return { command: command!, args };
}

/** The system prompt Attache's plugin gives one model call of a session in the agent home, as OpenCode 1 and OpenCode 2 build it. */
async function systemPromptForModelCall(): Promise<{ v1: string[]; v2: string[] }> {
  const [file] = readdirSync(PLUGINS).filter((f) => f.startsWith("attache"));
  type Plugin = {
    server: (input: { directory: string }) => Promise<Record<string, (i: object, o: { system: string[] }) => Promise<void>>>;
    setup: (ctx: object) => Promise<void>;
  };
  const plugin = ((await import(`${join(PLUGINS, file!)}?v=${Math.random()}`)) as { default: Plugin }).default;
  const v1 = { system: ["You are OpenCode."] };
  await (await plugin.server({ directory: HOME }))["experimental.chat.system.transform"]!({ sessionID: "ses_1", model: {} }, v1);
  let context: ((e: { system: Array<{ type: string; text: string }> }) => Promise<void>) | undefined;
  const hook = async (name: string, cb: typeof context) => ((name === "context" ? (context = cb) : undefined), { dispose: async () => {} });
  await plugin.setup({ location: { directory: HOME }, mcp: { transform: async () => ({ dispose: async () => {} }) }, session: { hook } });
  const v2 = { sessionID: "ses_1", system: [{ type: "text", text: "You are OpenCode." }] };
  await context!(v2);
  return { v1: v1.system, v2: v2.system.map((p) => p.text) };
}
const memoryFor = async (opencode: "v1" | "v2") => (await systemPromptForModelCall())[opencode].find((t) => t.startsWith("<attache-memory>")) ?? null;

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
  it("is its own Connection that reports MCP access, memory and session capture without a final event, and that a running OpenCode must restart", async () => {
    const defs = (await svc.get<{ definitions: Array<{ kind: string; label: string; description?: string; harness?: unknown }> }>("/capabilities")).definitions;
    const def = defs.find((d) => d.kind === "opencode");
    expect(def).toMatchObject({ label: "OpenCode", harness: { restartRequired: true, capabilities: { mcp: true, memory: "runtime-fresh", capture: "without-final-event" } } });
    expect(def!.description).toMatch(/memory/);
    expect(def!.description).toMatch(/save your OpenCode sessions/);
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

  it("gives each OpenCode model call the Brain's current memory in its system prompt, which follows the Brain when it changes", async () => {
    for (const opencode of ["v1", "v2"] as const) await expect.poll(() => memoryFor(opencode)).toMatch(/^<attache-memory>\n[\s\S]*Orion migration[\s\S]*\n<\/attache-memory>$/);
    await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Vega launch", facts: [{ subject: "Status", value: "Launch review on Thursday" }] }] });
    for (const opencode of ["v1", "v2"] as const) await expect.poll(() => memoryFor(opencode)).toMatch(/Vega launch/);
  });

  it("the server the plugin registers, started as OpenCode starts it, reaches the Brain", async () => {
    const client = await mcp.connectRegistered(await registeredByPlugin(), { name: "opencode" });
    const r = await callTool<{ passages: Array<{ title: string }> }>(client, "search", { query: "Orion cutover" });
    expect(r.isError).toBe(false);
    expect(r.data.passages[0]!.title).toBe("Orion migration");
  });

  it("testing a manual Connection reports its missing plugin and how to repair it", async () => {
    const file = readdirSync(PLUGINS).find((name) => name.startsWith("attache"));
    rmSync(join(PLUGINS, file!));
    try {
      const { test } = await svc.post<{ test: { ok: boolean; message: string } }>("/connections/opencode/test", {});
      expect(test.ok).toBe(false);
      expect(test.message).toContain(`plugin is not in ${join(PLUGINS, file!)}`);
      expect(test.message).toContain("Set up again");
    } finally {
      await svc.post("/connections/opencode/configure", { method: "mcp", fields: {} });
    }
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
  // Two `attache` commands from source, one after the other: a second alone, but while other test runs share the
  // computer one Node start can wait seconds (issue #9).
  it("the uninstaller removes the OpenCode plugin from the service's folder even when the shell sees another folder", { timeout: 60_000 }, async () => {
    await svc.post("/connections/opencode/configure", { method: "mcp", fields: {} });
    expect(readdirSync(PLUGINS)).toHaveLength(2);
    const main = join(import.meta.dirname, "../../src/main.ts");
    const status = JSON.parse(execFileSync(process.execPath, [main, "agent-hooks", "status", "--agent", "opencode", "--state-dir", svc.stateDir], { encoding: "utf8", env: { ...process.env, ATTACHE_AGENT_HOME: HOME } })) as Array<{ agent: string; state?: string }>;
    expect(status).toEqual([expect.objectContaining({ agent: "opencode", state: "current" })]);
    const otherEnv = { ...process.env, ATTACHE_AGENT_HOME: HOME, ATTACHE_STATE_DIR: svc.stateDir, OPENCODE_CONFIG_DIR: at("another-opencode-folder") };
    const out = JSON.parse(execFileSync(process.execPath, [main, "agent-hooks", "uninstall", "--state-dir", svc.stateDir], { encoding: "utf8", env: otherEnv })) as Array<{ agent: string; error?: string }>;
    expect(out.find((r) => r.agent === "opencode")).toMatchObject({ agent: "opencode", removed: 1 });
    expect(readdirSync(PLUGINS)).toEqual(["mine.js"]);
  });
});
