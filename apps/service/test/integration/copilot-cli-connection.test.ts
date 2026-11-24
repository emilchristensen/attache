import { execFileSync, spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { callTool, mcpClients } from "./mcp-client.ts";

/**
 * Copilot CLI as a Harness Connection through the service's public routes: preview, connect without
 * Copilot CLI having been found, the registered MCP server reaching the Brain, the personal
 * session-start hook handing Copilot CLI the memory the service keeps current, refusing a broken
 * configuration, status and disconnect, all without touching the owner's other servers or hooks.
 */

const HOME = process.env.ATTACHE_AGENT_HOME!;
const CONFIG = join(HOME, ".copilot", "mcp-config.json");
const HOOKS_DIR = join(HOME, ".copilot", "hooks");
const OWN_HOOKS = JSON.stringify({ version: 1, hooks: { sessionStart: [{ type: "command", bash: "echo '{}'" }] } });
const OWN = { mcpServers: { playwright: { type: "local", command: "npx", args: ["@playwright/mcp@latest"], tools: ["*"] } } };
const write = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};
const servers = () => (JSON.parse(readFileSync(CONFIG, "utf8")) as { mcpServers?: Record<string, { command: string; args: string[] }> }).mcpServers ?? {};

let svc: TestService;
const mcp = mcpClients();

interface Status {
  kind?: string;
  status: string;
  harness?: { state: string; message: string; files: string[] };
}
const connection = async () => (await svc.get<Status[]>("/connections")).find((s) => s.kind === "copilot-cli")!;

let hooksFile: string;

/** Run the session-start hook Attache installed, as Copilot CLI's hooks reference describes: its `bash` command, the sessionStart input on stdin. */
function sessionStart(cwd: string): string {
  const command = (JSON.parse(readFileSync(hooksFile, "utf8")) as { hooks: { sessionStart: Array<{ bash: string }> } }).hooks.sessionStart[0]!.bash;
  const r = spawnSync("bash", ["-c", command], { input: JSON.stringify({ sessionId: "s1", timestamp: Date.now(), cwd, source: "new", initialPrompt: "hi" }), encoding: "utf8" });
  expect(r.status).toBe(0);
  return r.stdout;
}

beforeAll(async () => {
  delete process.env.COPILOT_HOME;
  process.env.ATTACHE_COPILOT_BIN = join(HOME, "no-copilot-here");
  write(CONFIG, JSON.stringify(OWN, null, 2));
  write(join(HOOKS_DIR, "mine.json"), OWN_HOOKS);
  svc = await startTestService({ stateDir: mkdtempSync(join(tmpdir(), "attache-it-copilot-state-")) });
  await svc.post("/setup/identity", { name: "Ada Lovelace", email: "ada@example.com", confirm: true });
  await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned for the first weekend of December" }] }] });
});
afterAll(async () => {
  delete process.env.ATTACHE_COPILOT_BIN;
  await mcp.closeAll();
  await svc?.stop();
});

describe("Copilot CLI as a Harness Connection", () => {
  it("is its own Connection that reports MCP access, runtime-fresh memory, session capture with a final event, and that Copilot CLI must restart", async () => {
    const defs = (await svc.get<{ definitions: Array<{ kind: string; label: string; description: string; harness?: unknown; authMethods: Array<{ id: string }> }> }>("/capabilities")).definitions;
    const def = defs.find((d) => d.kind === "copilot-cli");
    expect(def).toMatchObject({ label: "Copilot CLI", authMethods: [{ id: "hooks" }], harness: { restartRequired: true, capabilities: { mcp: true, memory: "runtime-fresh", capture: "with-final-event" } } });
    expect(def!.description).toMatch(/give each new session your Attache memory/);
    expect(def!.description).toMatch(/save your Copilot CLI sessions/);
    expect((await connection()).status).not.toBe("connected");
  });

  it("previews the MCP configuration and the hooks file connecting would change, separately", async () => {
    const p = await svc.get<{ changes: Array<{ path: string; change: string; backup: boolean; purpose: string }>; restartRequired: boolean }>("/connections/copilot-cli/harness-preview");
    expect(p).toMatchObject({
      restartRequired: true,
      changes: [
        { path: CONFIG, change: "update", backup: true, purpose: expect.stringMatching(/MCP server/) },
        { path: expect.stringMatching(/[\\/]\.copilot[\\/]hooks[\\/]attache(-[0-9a-f]{8})?\.json$/), change: "create", backup: false, purpose: expect.stringMatching(/memory/) },
      ],
    });
    hooksFile = p.changes[1]!.path;
    expect(JSON.parse(readFileSync(CONFIG, "utf8"))).toEqual(OWN);
  });

  it("refuses a configuration that does not parse, naming it, and writes nothing", async () => {
    write(CONFIG, "{ nope");
    const r = await svc.call("GET", "/connections/copilot-cli/harness-preview");
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/mcp-config\.json is not valid JSON/);
    const c = await svc.call("POST", "/connections/copilot-cli/configure", { method: "mcp", fields: {} });
    expect(c.status).toBeGreaterThanOrEqual(400);
    expect(readFileSync(CONFIG, "utf8")).toBe("{ nope");
    write(CONFIG, JSON.stringify(OWN, null, 2));
  });

  it("connects even though Copilot CLI was not found, keeps the owner's server, and reports the Connection current", async () => {
    const r = await svc.post<{ test: { ok: boolean } }>("/connections/copilot-cli/configure", { method: "mcp", fields: {} });
    expect(r.test.ok).toBe(true);
    expect((await connection()).harness).toMatchObject({ state: "current", files: [CONFIG, hooksFile] });
    expect(Object.keys(servers()).sort()).toEqual([expect.stringMatching(/^attache(-[0-9a-f]{8})?$/), "playwright"]);
  });

  it("the server it registered, started as Copilot CLI starts it, reaches the Brain", async () => {
    const entry = Object.entries(servers()).find(([k]) => k.startsWith("attache"))![1];
    const client = await mcp.connectRegistered({ command: entry.command, args: entry.args }, { name: "copilot-cli" });
    const r = await callTool<{ passages: Array<{ title: string }> }>(client, "search", { query: "Orion cutover" });
    expect(r.isError).toBe(false);
    expect(r.data.passages[0]!.title).toBe("Orion migration");
  });

  it("the session-start hook it installed hands Copilot CLI the memory the service keeps current", async () => {
    await expect.poll(() => sessionStart(HOME)).toMatch(/Orion migration/);
    expect(JSON.parse(sessionStart(HOME)).additionalContext).toMatch(/^<attache-memory>\n[\s\S]*Orion migration[\s\S]*\n<\/attache-memory>$/);
    expect(sessionStart(HOME)).not.toMatch(/Vega launch/);
    await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Vega launch", facts: [{ subject: "Status", value: "Launch review on Thursday" }] }] });
    await expect.poll(() => sessionStart(HOME)).toMatch(/Vega launch/);
  });

  it("disconnecting removes Attache's entry and hooks file only, and says what it changed", async () => {
    const r = await svc.post<{ harness: { removed: Array<{ path: string; change: string }>; failures: string[] } }>("/connections/copilot-cli/disconnect", { deleteData: false });
    expect(r.harness).toEqual({ removed: [expect.objectContaining({ path: CONFIG, change: "update" }), expect.objectContaining({ path: hooksFile, change: "remove" })], failures: [] });
    expect(JSON.parse(readFileSync(CONFIG, "utf8"))).toEqual(OWN);
    expect(existsSync(hooksFile)).toBe(false);
    expect(readFileSync(join(HOOKS_DIR, "mine.json"), "utf8")).toBe(OWN_HOOKS);
  });
});

describe("uninstalling Attache", () => {
  it("the uninstaller's agent-hooks uninstall also removes Attache's Copilot CLI entry, and nothing else", async () => {
    await svc.post("/connections/copilot-cli/configure", { method: "mcp", fields: {} });
    expect(Object.keys(servers())).toHaveLength(2);
    const main = join(import.meta.dirname, "../../src/main.ts");
    const env = { ...process.env, ATTACHE_AGENT_HOME: HOME };
    const status = JSON.parse(execFileSync(process.execPath, [main, "agent-hooks", "status", "--agent", "copilot-cli", "--state-dir", svc.stateDir], { encoding: "utf8", env })) as Array<{ agent: string; state?: string }>;
    expect(status).toEqual([expect.objectContaining({ agent: "copilot-cli", state: "current", path: CONFIG })]);
    const out = JSON.parse(execFileSync(process.execPath, [main, "agent-hooks", "uninstall", "--state-dir", svc.stateDir], { encoding: "utf8", env })) as Array<{ agent: string; error?: string }>;
    expect(out.find((r) => r.agent === "copilot-cli")).toMatchObject({ agent: "copilot-cli", removed: 2 });
    expect(existsSync(hooksFile)).toBe(false);
    expect(readFileSync(join(HOOKS_DIR, "mine.json"), "utf8")).toBe(OWN_HOOKS);
    expect(existsSync(CONFIG)).toBe(true);
    expect(JSON.parse(readFileSync(CONFIG, "utf8"))).toEqual(OWN);
  });
});
