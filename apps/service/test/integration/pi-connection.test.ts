import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { callTool, mcpClients } from "./mcp-client.ts";

/**
 * Pi as a Harness Connection through the service's public routes: preview, connect without Pi
 * having been found, the registered MCP server reaching the Brain, status and disconnect.
 */

const HOME = process.env.ATTACHE_AGENT_HOME!;
const at = (...rel: string[]) => join(HOME, ...rel);
const EXTENSIONS = at(".pi/agent/extensions");
const write = (p: string, text: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
};

let svc: TestService;
let stateDir: string;
const mcp = mcpClients();

interface Status {
  kind?: string;
  status: string;
  harness?: { state: string; message: string; files: string[] };
}
const connection = async () => (await svc.get<Status[]>("/connections")).find((s) => s.kind === "pi")!;

/** What Attache's extension registers when Pi loads it, through a stand-in for Pi's extension API. */
async function registeredByExtension(): Promise<{ name: string; config: { command: string; args: string[] } }> {
  const [file] = readdirSync(EXTENSIONS).filter((f) => f.startsWith("attache"));
  const calls: Array<{ name: string; config: { command: string; args: string[] } }> = [];
  const mod = (await import(`${join(EXTENSIONS, file!)}?v=${Math.random()}`)) as { default: (api: unknown) => void };
  mod.default({ registerMcpServer: (name: string, config: never) => calls.push({ name, config }) });
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

beforeAll(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "attache-it-pi-state-"));
  // Pi is not in any folder Attache looks in; the owner's own extension and MCP server are.
  write(join(EXTENSIONS, "mine.ts"), "export default () => {};\n");
  write(at(".pi/agent/mcp.json"), JSON.stringify({ mcpServers: { files: { command: "npx", args: ["fs"] } } }));
  svc = await startTestService({ stateDir });
  await svc.post("/setup/identity", { name: "Ada Lovelace", email: "ada@example.com", confirm: true });
  await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned for the first weekend of December" }] }] });
});
afterAll(async () => {
  await mcp.closeAll();
  await svc?.stop();
});

describe("Pi as a Harness Connection", () => {
  it("is its own Connection that reports MCP access only and that a running Pi must reload", async () => {
    const defs = (await svc.get<{ definitions: Array<{ kind: string; label: string; harness?: unknown; authMethods: Array<{ id: string }> }> }>("/capabilities")).definitions;
    const def = defs.find((d) => d.kind === "pi");
    expect(def).toMatchObject({ label: "Pi", authMethods: [{ id: "mcp" }], harness: { restartRequired: true, capabilities: { mcp: true, memory: "none", capture: "none" } } });
    expect((await connection()).status).not.toBe("connected");
  });

  it("previews the one extension file connecting would create", async () => {
    const p = await svc.get<{ changes: Array<{ path: string; change: string; backup: boolean }>; restartRequired: boolean }>("/connections/pi/harness-preview");
    expect(p.restartRequired).toBe(true);
    expect(p.changes).toEqual([expect.objectContaining({ change: "create", backup: false, path: expect.stringContaining(EXTENSIONS) })]);
    expect(readdirSync(EXTENSIONS)).toEqual(["mine.ts"]);
  });

  it("connects even though Pi was not found, and reports the Connection current", async () => {
    const r = await svc.post<{ test: { ok: boolean } }>("/connections/pi/configure", { method: "mcp", fields: {} });
    expect(r.test.ok).toBe(true);
    const s = await connection();
    expect(s.harness?.state).toBe("current");
    expect(readdirSync(EXTENSIONS).sort()).toEqual([expect.stringMatching(/^attache(-[0-9a-f]{8})?\.ts$/), "mine.ts"]);
    expect(JSON.parse(readFileSync(at(".pi/agent/mcp.json"), "utf8"))).toEqual({ mcpServers: { files: { command: "npx", args: ["fs"] } } });
  });

  it("the server the extension registers, started as Pi starts it, reaches the Brain", async () => {
    const { config } = await registeredByExtension();
    const client = await mcp.connectRegistered(config, { name: "pi" });
    const r = await callTool<{ passages: Array<{ title: string }> }>(client, "search", { query: "Orion cutover" });
    expect(r.isError).toBe(false);
    expect(r.data.passages[0]!.title).toBe("Orion migration");
  });

  it("disconnecting removes Attache's extension only, and says what it removed", async () => {
    const r = await svc.post<{ harness: { removed: Array<{ path: string; change: string }>; failures: string[] } }>("/connections/pi/disconnect", { deleteData: false });
    expect(r.harness.failures).toEqual([]);
    expect(r.harness.removed).toEqual([expect.objectContaining({ change: "remove", path: expect.stringContaining(EXTENSIONS) })]);
    expect(readdirSync(EXTENSIONS)).toEqual(["mine.ts"]);
    expect(existsSync(at(".pi/agent/mcp.json"))).toBe(true);
  });
});

describe("uninstalling Attache", () => {
  it("the uninstaller's agent-hooks uninstall also removes Attache's Pi extension, and nothing else of Pi's", async () => {
    await svc.post("/connections/pi/configure", { method: "mcp", fields: {} });
    expect(readdirSync(EXTENSIONS)).toHaveLength(2);
    const main = join(import.meta.dirname, "../../src/main.ts");
    const out = JSON.parse(execFileSync(process.execPath, [main, "agent-hooks", "uninstall", "--state-dir", svc.stateDir], { encoding: "utf8", env: { ...process.env, ATTACHE_AGENT_HOME: HOME } })) as Array<{ agent: string; error?: string }>;
    expect(out.find((r) => r.agent === "pi")).toMatchObject({ agent: "pi" });
    expect(readdirSync(EXTENSIONS)).toEqual(["mine.ts"]);
  });
});
