/**
 * Starts the real service bundle and the TEST-ONLY fixture remotes for browser
 * journeys. Remote services (GitHub, Jira, ...) and the model are fixtures here;
 * nothing in these journeys is reported as a live integration result.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { fixtureModelDescription } from "../../apps/service/test/fixtures/fixture-meaning-model.ts";
import { consolidationLine } from "../../apps/service/test/fixtures/fixture-model.ts";
import { meetingCapture } from "../../apps/service/test/fixtures/meeting-capture.ts";

export const ROOT = resolve(import.meta.dirname, "../..");
const BUNDLE = join(ROOT, "apps/service/dist/attache-service.mjs");
/** The service from source as a release install runs it, with a fake installer runner (TEST-ONLY). */
const UPDATE_SERVICE = join(ROOT, "tests/e2e/update-service.ts");
const NODE = process.execPath;
/** Vite's own entry, run with this Node: `npx` is a batch file on Windows, which Node does not start without a shell. */
const VITE = join(ROOT, "apps/web/node_modules/vite/bin/vite.js");

/**
 * A stack whose service updates itself as a release install does (`update-service.ts`): it runs `version`, reads
 * releases from `feedUrl` and trusts `publicKey`, and its installer runner only records what it is asked.
 */
export interface UpdatesOptions {
  feedUrl: string;
  publicKey: string;
  version: string;
}

export interface Stack {
  /** The service's address; the OS picks its port, so several runs on one machine never collide. */
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
  /** Start the service again; with Updates, on `version` when named, as the installer of an Update does. */
  startService(opts?: { version?: string }): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The first match of `re` in what `child` prints; fails as soon as `child` ends without printing it. No timer of its
 * own: while other test runs share the computer, starting Node alone can take many seconds (issue #9), so a fixed
 * limit gave up on a process that was still starting. The hook's own timeout still bounds the wait.
 */
function waitForLine(child: ChildProcess, re: RegExp): Promise<string> {
  return new Promise((res, rej) => {
    let buf = "";
    const ended = (code: number | null, signal: NodeJS.Signals | null) => rej(new Error(`the process ended (${code ?? signal}) without printing ${re}: ${buf}`));
    child.once("close", ended);
    child.stdout!.on("data", (d) => {
      buf += String(d);
      const m = re.exec(buf);
      if (m) {
        child.off("close", ended);
        res(m[1] ?? m[0]);
      }
    });
  });
}

export function buildAll() {
  execFileSync(NODE, [join(ROOT, "apps/service/build.mjs")], { stdio: "ignore" });
  if (!existsSync(join(ROOT, "apps/web/dist/index.html")) || process.env.ATTACHE_E2E_REBUILD_WEB !== "0") execFileSync(NODE, [VITE, "build"], { cwd: join(ROOT, "apps/web"), stdio: "ignore" });
}

export function makeVault(dir: string) {
  const day = (o: number) => new Date(Date.now() + o * 86_400_000).toISOString().slice(0, 10);
  mkdirSync(join(dir, "Projects"), { recursive: true });
  mkdirSync(join(dir, "People"), { recursive: true });
  writeFileSync(join(dir, "Projects/Orion.md"), `---\ntitle: Orion migration\n---\n# Orion migration\n\nOwner: Priya Shah. The Orion migration moves billing to the new ledger service.\n\n## Tasks\n- [ ] Send the cutover plan to finance 📅 ${day(1)}\n- [ ] Review rollback runbook due:${day(-2)}\n\n## Decisions\nWe chose a weekend cutover to avoid invoice runs.\n`);
  writeFileSync(join(dir, "People/Priya Shah.md"), "# Priya Shah\n\nEngineering manager for billing. Prefers written updates on Mondays.\n");
}

export async function startStack(opts: { updates?: UpdatesOptions } = {}): Promise<Stack> {
  // A space and non-ASCII letters in every path, as in many owners' home folders.
  const stateDir = mkdtempSync(join(tmpdir(), "attache-e2e-state æøå-"));
  const base = mkdtempSync(join(tmpdir(), "attache-e2e æøå-"));
  const dataDir = join(base, "Attache");
  const vaultDir = join(base, "vault");
  makeVault(vaultDir);
  const agentHome = join(base, "home");
  mkdirSync(join(agentHome, ".claude"), { recursive: true });
  writeFileSync(join(agentHome, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }] } }, null, 2));
  const fixture = spawn(NODE, [join(ROOT, "apps/service/test/fixtures/run-fixture-server.ts"), "0"], { stdio: ["ignore", "pipe", "inherit"] });
  const fixtureUrl = await waitForLine(fixture, /FIXTURE_READY (\S+)/);
  // claude.ai connectors go through the fixture CLI with an empty Claude config: journeys never reach a real account.
  const claude = { ATTACHE_CLAUDE_BIN: join(ROOT, "apps/service/test/fixtures", process.platform === "win32" ? "fake-claude.cmd" : "fake-claude.mjs"), ATTACHE_FAKE_CLAUDE_URL: fixtureUrl, CLAUDE_CONFIG_DIR: mkdtempSync(join(tmpdir(), "attache-e2e-claude-")) };
  // The meaning model comes from the fixture server, never from Hugging Face.
  const meaningModel = join(base, "meaning-model.json");
  writeFileSync(meaningModel, JSON.stringify(fixtureModelDescription(`${fixtureUrl}/meaning-model`)));
  const env: NodeJS.ProcessEnv = { ...process.env, ATTACHE_MEANING_MODEL: meaningModel, ATTACHE_CREDENTIAL_STORE: "file", ATTACHE_NO_NOTIFY: "1", ATTACHE_TEST_ENDPOINTS: "1", ATTACHE_FIXTURE_URL: fixtureUrl, ATTACHE_INSTANCE: "e2e", ATTACHE_AGENT_HOME: agentHome, ATTACHE_LOCK_DIR: join(base, "locks"), ...claude };
  // OpenCode's config folder is under the test home, and the Machine's own OpenCode is never asked for its version.
  for (const key of ["XDG_CONFIG_HOME", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG"]) delete env[key];
  env.ATTACHE_OPENCODE_BIN = join(base, "no-opencode");
  // Harness executables are looked for only in the test home's own tool folder, never in the Machine's (/opt/homebrew/bin may have Codex).
  env.ATTACHE_HARNESS_TOOL_DIRS = join(agentHome, ".local", "bin");
  // Copilot CLI's home folder is under the test home too, and the Machine's own Copilot CLI is never asked for its version.
  delete env.COPILOT_HOME;
  env.ATTACHE_COPILOT_BIN = join(base, "no-copilot");
  let service: ChildProcess | null = null;
  // The first start asks the OS for a free port; a restart reuses it, so the paired browser keeps its origin.
  let port = 0;
  let version = opts.updates?.version;
  const command = () =>
    opts.updates
      ? { args: [UPDATE_SERVICE, "--state-dir", stateDir, "--port", String(port), "--prefix", join(base, "install"), "--requests", installRequestsFile(stateDir)], env: { ...env, ATTACHE_RELEASE_FEED_URL: opts.updates.feedUrl, ATTACHE_RELEASE_PUBLIC_KEY: opts.updates.publicKey, ATTACHE_VERSION: version! } }
      : { args: [BUNDLE, "serve", "--state-dir", stateDir, "--port", String(port)], env };
  const startService = async (start: { version?: string } = {}) => {
    version = start.version ?? version;
    const { args, env: serviceEnv } = command();
    service = spawn(NODE, args, { env: serviceEnv, stdio: ["ignore", "pipe", "inherit"] });
    await waitForLine(service, /attache service listening/);
    port = boundPort(stateDir);
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
 * Save items the way a Harness does: it starts Attache's MCP server, calls the
 * save tool from one of its sessions, and the owner accepts the confirmation.
 */
export async function harnessSave(stack: Stack, items: unknown[], origin: { agent: string; session: string }) {
  const sessionEnv = HARNESS_SESSION_ENV[origin.agent];
  if (!sessionEnv) throw new Error(`No session environment for Harness ${origin.agent}`);
  const base = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !/^(CLAUDECODE|CLAUDE_CODE_|CODEX_|ANTIGRAVITY_)/.test(e[0])));
  const transport = new StdioClientTransport({ command: NODE, args: [BUNDLE, "mcp", "--state-dir", stack.stateDir], env: { ...base, ATTACHE_CREDENTIAL_STORE: "file", ...sessionEnv(origin.session) }, stderr: "pipe" });
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

/**
 * A meeting capture arriving in the Brain, as the owner's meeting export writes
 * one, with Consolidation's model reply scripted inside it: the e2e fixture
 * model answers Consolidation with `reply` (each entry's evidence quoted from `lines`).
 */
export function arriveMeetingCapture(stack: Stack, relPath: string, title: string, lines: readonly string[], reply: unknown) {
  const file = join(stack.dataDir, relPath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, meetingCapture(title, [...lines, consolidationLine(reply)]));
}

/**
 * Let a draft's approval run out, as if the owner had walked away for its 15
 * minutes: the stored approval now ended a second ago. The service's clock is
 * the real one in journeys, so the stored time moves instead.
 */
export function endApproval(stack: Stack, actionId: string) {
  const db = new DatabaseSync(join(stack.stateDir, "attache.sqlite"), { timeout: 5_000 });
  try {
    const row = db.prepare("select approval from actions where id = ?").get(actionId) as { approval: string | null } | undefined;
    if (!row?.approval) throw new Error(`Draft ${actionId} has no approval to end`);
    const approval = JSON.parse(row.approval) as Record<string, unknown>;
    const ended = Date.now() - 1_000;
    db.prepare("update actions set approval = ? where id = ?").run(JSON.stringify({ ...approval, approvedAt: new Date(ended - 15 * 60_000).toISOString(), expiresAt: new Date(ended).toISOString() }), actionId);
  } finally {
    db.close();
  }
}

/** Where the Updates stack's fake installer runner records what it is asked: one line of JSON per request. */
const installRequestsFile = (stateDir: string) => join(stateDir, "e2e-install-requests.jsonl");

/** What the Updater handed the fake installer runner, oldest first: the version each request installs. */
export function installRequests(stack: Stack): string[] {
  const file = installRequestsFile(stack.stateDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { version: string }).version);
}

export function readRuntime(stateDir: string) {
  return JSON.parse(readFileSync(join(stateDir, "runtime.json"), "utf8"));
}

/** The port the service bound, from the runtime file it writes before it reports listening. */
function boundPort(stateDir: string): number {
  const port: unknown = readRuntime(stateDir).port;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) throw new Error(`The service did not record the port it listens on: ${JSON.stringify(port)}`);
  return port;
}
