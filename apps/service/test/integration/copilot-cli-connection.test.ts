import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { callTool, mcpClients } from "./mcp-client.ts";

/**
 * Copilot CLI as a Harness Connection through the service's public routes: preview, connect without
 * Copilot CLI having been found, the registered MCP server reaching the Brain, refusing a broken
 * configuration, status and disconnect, all without touching the owner's other servers.
 */

const HOME = process.env.ATTACHE_AGENT_HOME!;
const CONFIG = join(HOME, ".copilot", "mcp-config.json");
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

beforeAll(async () => {
  delete process.env.COPILOT_HOME;
  write(CONFIG, JSON.stringify(OWN, null, 2));
  svc = await startTestService({ stateDir: mkdtempSync(join(tmpdir(), "attache-it-copilot-state-")) });
  await svc.post("/setup/identity", { name: "Ada Lovelace", email: "ada@example.com", confirm: true });
  await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned for the first weekend of December" }] }] });
});
afterAll(async () => {
  await mcp.closeAll();
  await svc?.stop();
});

describe("Copilot CLI as a Harness Connection", () => {
  it("is its own Connection that reports MCP access only and that a running Copilot CLI must restart", async () => {
    const defs = (await svc.get<{ definitions: Array<{ kind: string; label: string; harness?: unknown; authMethods: Array<{ id: string }> }> }>("/capabilities")).definitions;
    expect(defs.find((d) => d.kind === "copilot-cli")).toMatchObject({ label: "Copilot CLI", authMethods: [{ id: "mcp" }], harness: { restartRequired: true, capabilities: { mcp: true, memory: "none", capture: "none" } } });
    expect((await connection()).status).not.toBe("connected");
  });

  it("previews the one file connecting would change, with a backup", async () => {
    const p = await svc.get<{ changes: Array<{ path: string; change: string; backup: boolean }>; restartRequired: boolean }>("/connections/copilot-cli/harness-preview");
    expect(p).toMatchObject({ restartRequired: true, changes: [{ path: CONFIG, change: "update", backup: true }] });
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
    expect((await connection()).harness).toMatchObject({ state: "current", files: [CONFIG] });
    expect(Object.keys(servers()).sort()).toEqual([expect.stringMatching(/^attache(-[0-9a-f]{8})?$/), "playwright"]);
  });

  it("the server it registered, started as Copilot CLI starts it, reaches the Brain", async () => {
    const entry = Object.entries(servers()).find(([k]) => k.startsWith("attache"))![1];
    const client = await mcp.connectRegistered({ command: entry.command, args: entry.args }, { name: "copilot-cli" });
    const r = await callTool<{ passages: Array<{ title: string }> }>(client, "search", { query: "Orion cutover" });
    expect(r.isError).toBe(false);
    expect(r.data.passages[0]!.title).toBe("Orion migration");
  });

  it("disconnecting removes Attache's entry only, and says what it changed", async () => {
    const r = await svc.post<{ harness: { removed: Array<{ path: string; change: string }>; failures: string[] } }>("/connections/copilot-cli/disconnect", { deleteData: false });
    expect(r.harness).toEqual({ removed: [expect.objectContaining({ path: CONFIG, change: "update" })], failures: [] });
    expect(JSON.parse(readFileSync(CONFIG, "utf8"))).toEqual(OWN);
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
    expect(out.find((r) => r.agent === "copilot-cli")).toMatchObject({ agent: "copilot-cli", removed: 1 });
    expect(existsSync(CONFIG)).toBe(true);
    expect(JSON.parse(readFileSync(CONFIG, "utf8"))).toEqual(OWN);
  });
});
