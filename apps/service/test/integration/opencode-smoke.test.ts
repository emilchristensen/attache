import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";

/**
 * Smoke test against the real OpenCode executable, in an isolated home: connecting OpenCode through
 * Attache makes the real OpenCode load Attache's plugin and connect Attache's MCP server, and
 * disconnecting leaves OpenCode with no Attache server. It runs only where `opencode` is on PATH (or
 * `ATTACHE_OPENCODE_EXECUTABLE` names it) and is skipped otherwise. It needs no model credentials.
 *
 * OpenCode 1 lists its MCP servers itself (`opencode mcp list`). OpenCode 2 loads plugins in its
 * server, so the test starts a private one (`opencode serve`) and asks it.
 *
 * ADR 0006: Attache may call OpenCode's MCP access officially supported only while this passes,
 * for the OpenCode versions it ran against; a failure here withdraws that claim for OpenCode only.
 */

function findOpenCode(): string | null {
  if (process.env.ATTACHE_OPENCODE_EXECUTABLE) return process.env.ATTACHE_OPENCODE_EXECUTABLE;
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of ["opencode", "opencode.cmd", "opencode.exe"]) if (existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}
const OPENCODE = findOpenCode();

let svc: TestService;
let root: string;
let env: NodeJS.ProcessEnv;
let major: number;

const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run an OpenCode command in the isolated home and return what it printed. */
function opencode(args: string[], timeout = 90_000): string {
  const r = spawnSync(OPENCODE!, args, { cwd: join(root, "work"), env, encoding: "utf8", timeout, windowsHide: true, shell: process.platform === "win32" });
  return plain(`${r.stdout ?? ""}${r.stderr ?? ""}`);
}

/** OpenCode 2: start a private server in the isolated home and return its URL. */
async function serve(): Promise<{ url: string; child: ChildProcess }> {
  const child = spawn(OPENCODE!, ["serve", "--port", "0"], { cwd: join(root, "work"), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: process.platform === "win32" });
  let out = "";
  child.stdout!.on("data", (d) => (out += String(d)));
  child.stderr!.on("data", (d) => (out += String(d)));
  const deadline = Date.now() + 60_000;
  for (;;) {
    const url = /listening on (http:\/\/\S+)/.exec(plain(out))?.[1];
    if (url) return { url, child };
    if (child.exitCode !== null) throw new Error(`opencode serve exited with ${child.exitCode}: ${out}`);
    if (Date.now() > deadline) throw new Error(`opencode serve did not start within 60 s: ${out}`);
    await sleep(200);
  }
}

/** The plugins OpenCode 2's server has active for the work folder, once it has loaded any. */
async function activePlugins(url: string): Promise<string[]> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const text = opencode(["api", "GET", "/api/plugin", "--server", url]);
    try {
      const data = (JSON.parse(text) as { data: Array<{ id: string; state: { status: string } }> }).data;
      if (data.length) return data.filter((p) => p.state.status === "active").map((p) => p.id);
    } catch {
      // Not JSON yet: the server is still booting the location; ask again below.
    }
    if (Date.now() > deadline) throw new Error(`OpenCode listed no plugins within 60 s: ${text}`);
    await sleep(500);
  }
}

/** What `opencode mcp list` says about each server, by name: OpenCode 1 prints "●  ✓ <name> connected", OpenCode 2 "✓ <name>  connected". */
async function mcpServers(server: string | null): Promise<Record<string, string>> {
  const parse = (text: string) => Object.fromEntries([...text.matchAll(/[✓✗○]\s+(\S+)\s+(\S.*)$/gm)].map((m) => [m[1]!, m[2]!.trim()]));
  if (major === 1) return parse(opencode(["mcp", "list"]));
  const { url, child } = await serve();
  try {
    const plugins = await activePlugins(url);
    if (server) expect(plugins).toContain(server);
    else expect(plugins.filter((p) => p.startsWith("attache"))).toEqual([]);
    // The plugin's transform is reconciled shortly after it loads.
    const deadline = Date.now() + 30_000;
    for (;;) {
      const servers = parse(opencode(["mcp", "list", "--server", url]));
      if (!server || /connected/.test(servers[server] ?? "") || Date.now() > deadline) return servers;
      await sleep(500);
    }
  } finally {
    child.kill();
  }
}

describe.skipIf(!OPENCODE)("the real OpenCode executable", () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "attache-opencode-smoke-"));
    for (const d of ["work", "config", "managed"]) mkdirSync(join(root, d));
    // OpenCode and Attache both use this home and config folder, so the owner's real OpenCode setup is never touched.
    env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCODE_TEST_HOME: root,
      OPENCODE_DB: join(root, "opencode.db"),
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
      XDG_STATE_HOME: join(root, "state"),
      OPENCODE_TEST_MANAGED_CONFIG_DIR: join(root, "managed"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_PASSWORD: "attache-smoke",
    };
    delete env.OPENCODE_CONFIG;
    delete env.OPENCODE_CONFIG_DIR;
    delete env.OPENCODE_CONFIG_CONTENT;
    process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
    process.env.ATTACHE_OPENCODE_BIN = OPENCODE!;
    const version = opencode(["--version"]).trim();
    major = Number(/(\d+)\.\d+\.\d+/.exec(version)?.[1]);
    expect([1, 2], `opencode --version printed "${version}"`).toContain(major);
    svc = await startTestService({ stateDir: mkdtempSync(join(tmpdir(), "attache-opencode-smoke-state-")) });
  });
  afterAll(async () => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.ATTACHE_OPENCODE_BIN;
    await svc?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const plugins = () => join(root, "config", "opencode", "plugins");

  // Each case starts the real OpenCode and Attache's MCP server, which together take far longer than a unit test.
  it("loads Attache's plugin and connects Attache's MCP server once Attache connects OpenCode", { timeout: 180_000 }, async () => {
    await svc.post("/connections/opencode/configure", { method: "mcp", fields: {} });
    const [file] = readdirSync(plugins());
    const server = file!.replace(/\.js$/, "");
    const servers = await mcpServers(server);
    expect(servers[server], JSON.stringify(servers)).toMatch(/connected/);
  });

  it("leaves OpenCode with no Attache plugin or server after disconnecting", { timeout: 180_000 }, async () => {
    const d = await svc.post<{ harness: { failures: string[] } }>("/connections/opencode/disconnect", { deleteData: false });
    expect(d.harness.failures).toEqual([]);
    expect(readdirSync(plugins()).filter((f) => f.startsWith("attache"))).toEqual([]);
    const servers = await mcpServers(null);
    expect(Object.keys(servers).filter((n) => n.startsWith("attache"))).toEqual([]);
  });
});
