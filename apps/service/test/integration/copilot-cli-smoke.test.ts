import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { callTool, mcpClients } from "./mcp-client.ts";

/**
 * Smoke test against the real Copilot CLI executable, in an isolated home: after Attache connects
 * Copilot CLI, the real `copilot mcp list` / `copilot mcp get` load Attache's server from the
 * personal MCP configuration (source "user", enabled) next to the owner's own server, and the
 * server Copilot CLI reports starts and reaches the Brain; after disconnecting, Copilot CLI lists
 * no Attache server and still lists the owner's. It runs only where `copilot` is on PATH (or
 * `ATTACHE_COPILOT_EXECUTABLE` names it) and is skipped otherwise.
 *
 * It needs no GitHub sign-in, and runs with none: every token variable is removed and `gh` gets an
 * empty config folder. That is also its limit: a Copilot CLI session (`copilot -p`) refuses to start
 * without a sign-in, so this does not show Copilot CLI itself starting Attache's server in a session
 * or the name its MCP client gives itself.
 *
 * ADR 0006: Attache may call Copilot CLI's MCP access officially supported only while this passes,
 * for the Copilot CLI versions it ran against; a failure here withdraws that claim for Copilot CLI only.
 */

function findCopilot(): string | null {
  if (process.env.ATTACHE_COPILOT_EXECUTABLE) return process.env.ATTACHE_COPILOT_EXECUTABLE;
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of ["copilot", "copilot.cmd", "copilot.exe"]) if (existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}
const COPILOT = findCopilot();

let svc: TestService;
let root: string;
let env: NodeJS.ProcessEnv;
const mcp = mcpClients();
const OWN = '{\n  // the owner\'s own\n  "mcpServers": { "playwright": { "type": "local", "command": "npx", "args": ["@playwright/mcp@latest"], "tools": ["*"] } },\n}\n';

interface Listed {
  command?: string;
  args?: string[];
  source?: string;
  enabled?: boolean;
}

/** Run a Copilot CLI command in the isolated home and return its exit status and output. */
function copilot(args: string[]): { status: number | null; out: string } {
  const r = spawnSync(COPILOT!, args, { cwd: join(root, "work"), env, encoding: "utf8", timeout: 60_000, windowsHide: true, shell: process.platform === "win32" });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** The MCP servers Copilot CLI loads from its user configuration, by name. */
function userServers(): Record<string, Listed> {
  const r = copilot(["mcp", "list", "--json"]);
  expect(r.status, r.out).toBe(0);
  const all = (JSON.parse(r.out) as { mcpServers: Record<string, Listed> }).mcpServers;
  return Object.fromEntries(Object.entries(all).filter(([, s]) => s.source === "user"));
}

describe.skipIf(!COPILOT)("the real Copilot CLI executable", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "attache-copilot-smoke-"));
    for (const d of ["work", "copilot", "cache", "gh"]) mkdirSync(join(root, d));
    writeFileSync(join(root, "copilot", "mcp-config.json"), OWN);
    env = {
      ...process.env,
      // The npm package's loader is a Node script.
      PATH: [dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)].join(delimiter),
      HOME: root,
      USERPROFILE: root,
      COPILOT_HOME: join(root, "copilot"),
      COPILOT_CACHE_HOME: join(root, "cache"),
      COPILOT_AUTO_UPDATE: "false",
      GH_CONFIG_DIR: join(root, "gh"),
      NO_COLOR: "1",
    };
    for (const key of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) delete env[key];
    // Attache writes to the same isolated Copilot CLI home.
    process.env.COPILOT_HOME = env.COPILOT_HOME;
    const version = copilot(["--version"]).out;
    expect(version, `copilot --version printed "${version}"`).toMatch(/\d+\.\d+\.\d+/);
    svc = await startTestService({ stateDir: mkdtempSync(join(tmpdir(), "attache-copilot-smoke-state-")) });
    await svc.post("/setup/identity", { name: "Ada Lovelace", email: "ada@example.com", confirm: true });
    await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned for the first weekend of December" }] }] });
  });
  afterAll(async () => {
    delete process.env.COPILOT_HOME;
    await mcp.closeAll();
    await svc?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("loads Attache's server from the personal MCP configuration, enabled, next to the owner's, once Attache connects Copilot CLI", { timeout: 120_000 }, async () => {
    expect(Object.keys(userServers())).toEqual(["playwright"]);
    const r = await svc.post<{ test: { ok: boolean } }>("/connections/copilot-cli/configure", { method: "mcp", fields: {} });
    expect(r.test.ok).toBe(true);
    const servers = userServers();
    const name = Object.keys(servers).find((n) => n.startsWith("attache"));
    expect(Object.keys(servers).sort(), JSON.stringify(servers)).toEqual([name, "playwright"]);
    expect(servers[name!]).toMatchObject({ source: "user", enabled: true });
    const got = copilot(["mcp", "get", name!, "--json"]);
    expect(got.status, got.out).toBe(0);
    const server = (JSON.parse(got.out) as Record<string, Listed>)[name!]!;
    // The server exactly as Copilot CLI read it starts and answers from the Brain.
    const client = await mcp.connectRegistered({ command: server.command!, args: server.args! }, { name: "copilot-cli-smoke" });
    const found = await callTool<{ passages: Array<{ title: string }> }>(client, "search", { query: "Orion cutover" });
    expect(found.isError).toBe(false);
    expect(found.data.passages[0]!.title).toBe("Orion migration");
  });

  it("lists no Attache server, and still the owner's, after disconnecting", { timeout: 120_000 }, async () => {
    const d = await svc.post<{ harness: { failures: string[] } }>("/connections/copilot-cli/disconnect", { deleteData: false });
    expect(d.harness.failures).toEqual([]);
    expect(Object.keys(userServers())).toEqual(["playwright"]);
    expect(readFileSync(join(root, "copilot", "mcp-config.json"), "utf8")).not.toMatch(/attache/);
  });
});
