/**
 * Starts the real service bundle and the TEST-ONLY fixture remotes for browser
 * journeys. Remote services (GitHub, Jira, ...) and the model are fixtures here;
 * nothing in these journeys is reported as a live integration result.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { fixtureModelDescription } from "../../apps/service/test/fixtures/fixture-meaning-model.ts";

export const ROOT = resolve(import.meta.dirname, "../..");
const BUNDLE = join(ROOT, "apps/service/dist/jarvis-service.mjs");
const NODE = process.execPath;
/** Vite's own entry, run with this Node: `npx` is a batch file on Windows, which Node does not start without a shell. */
const VITE = join(ROOT, "apps/web/node_modules/vite/bin/vite.js");

export interface Stack {
  url: string;
  port: number;
  fixtureUrl: string;
  stateDir: string;
  dataDir: string;
  vaultDir: string;
  /** Home folder whose Harness settings the service edits; never the real one. */
  agentHome: string;
  pairUrl(): string;
  stopService(): Promise<void>;
  startService(): Promise<void>;
  stop(): Promise<void>;
}

function waitForLine(child: ChildProcess, re: RegExp, timeoutMs = 15_000): Promise<string> {
  return new Promise((res, rej) => {
    let buf = "";
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${re}: ${buf}`)), timeoutMs);
    child.stdout!.on("data", (d) => {
      buf += String(d);
      const m = re.exec(buf);
      if (m) {
        clearTimeout(t);
        res(m[1] ?? m[0]);
      }
    });
  });
}

export function buildAll() {
  execFileSync(NODE, [join(ROOT, "apps/service/build.mjs")], { stdio: "ignore" });
  if (!existsSync(join(ROOT, "apps/web/dist/index.html")) || process.env.JARVIS_E2E_REBUILD_WEB !== "0") execFileSync(NODE, [VITE, "build"], { cwd: join(ROOT, "apps/web"), stdio: "ignore" });
}

export function makeVault(dir: string) {
  const day = (o: number) => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);
  mkdirSync(join(dir, "Projects"), { recursive: true });
  mkdirSync(join(dir, "People"), { recursive: true });
  writeFileSync(join(dir, "Projects/Orion.md"), `---\ntitle: Orion migration\n---\n# Orion migration\n\nOwner: Priya Shah. The Orion migration moves billing to the new ledger service.\n\n## Tasks\n- [ ] Send the cutover plan to finance 📅 ${day(1)}\n- [ ] Review rollback runbook due:${day(-2)}\n\n## Decisions\nWe chose a weekend cutover to avoid invoice runs.\n`);
  writeFileSync(join(dir, "People/Priya Shah.md"), "# Priya Shah\n\nEngineering manager for billing. Prefers written updates on Mondays.\n");
}

export async function startStack(opts: { port?: number } = {}): Promise<Stack> {
  const port = opts.port ?? 7610;
  // A space and non-ASCII letters in every path, as in many owners' home folders.
  const stateDir = mkdtempSync(join(tmpdir(), "jarvis-e2e-state æøå-"));
  const base = mkdtempSync(join(tmpdir(), "jarvis-e2e æøå-"));
  const dataDir = join(base, "Jarvis");
  const vaultDir = join(base, "vault");
  makeVault(vaultDir);
  const agentHome = join(base, "home");
  mkdirSync(join(agentHome, ".claude"), { recursive: true });
  writeFileSync(join(agentHome, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }] } }, null, 2));
  const fixture = spawn(NODE, [join(ROOT, "apps/service/test/fixtures/run-fixture-server.ts"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
  const fixtureUrl = await waitForLine(fixture, /FIXTURE_READY (\S+)/);
  // claude.ai connectors go through the fixture CLI with an empty Claude config: journeys never reach a real account.
  const claude = { JARVIS_CLAUDE_BIN: join(ROOT, "apps/service/test/fixtures", process.platform === "win32" ? "fake-claude.cmd" : "fake-claude.mjs"), JARVIS_FAKE_CLAUDE_URL: fixtureUrl, CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "jarvis-e2e-claude-")) };
  // The meaning model comes from the fixture server, never from Hugging Face.
  const meaningModel = join(base, "meaning-model.json");
  writeFileSync(meaningModel, JSON.stringify(fixtureModelDescription(`${fixtureUrl}/meaning-model`)));
  const env = { ...process.env, JARVIS_MEANING_MODEL: meaningModel, JARVIS_CREDENTIAL_STORE: "file", JARVIS_NO_NOTIFY: "1", JARVIS_TEST_ENDPOINTS: "1", JARVIS_FIXTURE_URL: fixtureUrl, JARVIS_INSTANCE: "e2e", JARVIS_AGENT_HOME: agentHome, JARVIS_LOCK_DIR: join(base, "locks"), ...claude };
  let service: ChildProcess | null = null;
  const startService = async () => {
    service = spawn(NODE, [BUNDLE, "serve", "--state-dir", stateDir, "--port", String(port)], { env, stdio: ["ignore", "pipe", "inherit"] });
    await waitForLine(service, /jarvis service listening/);
  };
  const stopService = async () => {
    if (!service) return;
    const s = service;
    service = null;
    s.kill("SIGTERM");
    await new Promise((r) => s.once("exit", r));
  };
  await startService();
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    fixtureUrl,
    stateDir,
    dataDir,
    vaultDir,
    agentHome,
    pairUrl() {
      const out = JSON.parse(execFileSync(NODE, [BUNDLE, "pair", "--state-dir", stateDir, "--json"], { env }).toString());
      return out.url;
    },
    startService,
    stopService,
    async stop() {
      await stopService();
      fixture.kill("SIGTERM");
    },
  };
}

/** The environment each Harness gives the processes it starts, naming its session. */
const HARNESS_SESSION_ENV: Record<string, (session: string) => Record<string, string>> = {
  "claude-code": (session) => ({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: session }),
  codex: (session) => ({ CODEX_THREAD_ID: session }),
  antigravity: (session) => ({ ANTIGRAVITY_CONVERSATION_ID: session }),
};

/**
 * Save items the way a Harness does: it starts Jarvis's MCP server, calls the
 * save tool from one of its sessions, and the owner accepts the confirmation.
 */
export async function harnessSave(stack: Stack, items: unknown[], origin: { agent: string; session: string }) {
  const sessionEnv = HARNESS_SESSION_ENV[origin.agent];
  if (!sessionEnv) throw new Error(`No session environment for Harness ${origin.agent}`);
  const base = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !/^(CLAUDECODE|CLAUDE_CODE_|CODEX_|ANTIGRAVITY_)/.test(e[0])));
  const transport = new StdioClientTransport({ command: NODE, args: [BUNDLE, "mcp", "--state-dir", stack.stateDir], env: { ...base, JARVIS_CREDENTIAL_STORE: "file", ...sessionEnv(origin.session) }, stderr: "pipe" });
  const client = new Client({ name: origin.agent, version: "1.0.0" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: {} }));
  await client.connect(transport);
  try {
    const r = await client.callTool({ name: "save", arguments: { items } });
    const outcome = (r.structuredContent as { outcome?: string } | undefined)?.outcome;
    if (r.isError || outcome !== "saved") throw new Error(`The save did not go through: ${JSON.stringify(r.content)}`);
  } finally {
    await client.close();
  }
}

export function readRuntime(stateDir: string) {
  return JSON.parse(readFileSync(join(stateDir, "runtime.json"), "utf8"));
}
