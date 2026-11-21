import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";

/**
 * Smoke test against the real OpenCode executable, in an isolated home: connecting OpenCode through
 * Attache makes the real OpenCode load Attache's plugin, connect Attache's MCP server and send the
 * Brain's current memory with each model call without saving it, saves the conversation at each
 * turn's end and before each compaction, and disconnecting leaves OpenCode
 * with no Attache server and no memory. The model is a local stand-in that records what OpenCode
 * sends it, so no model account is needed. It runs only where `opencode` is on PATH (or
 * `ATTACHE_OPENCODE_EXECUTABLE` names it) and is skipped otherwise.
 *
 * OpenCode 1 lists its MCP servers itself (`opencode mcp list`). OpenCode 2 loads plugins in its
 * server, so the test starts a private one (`opencode serve`) and asks it.
 *
 * ADR 0006: Attache may call OpenCode's MCP access, memory and session capture officially supported only while this passes,
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

/** Start a private OpenCode server in the isolated home and return its URL. */
async function serve(): Promise<{ url: string; child: ChildProcess }> {
  const child = spawn(OPENCODE!, ["serve", "--port", "0"], { cwd: join(root, "work"), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: process.platform === "win32" });
  let out = "";
  child.stdout!.on("data", (d) => (out += String(d)));
  child.stderr!.on("data", (d) => (out += String(d)));
  const deadline = Date.now() + 60_000;
  for (;;) {
    const url = /listening on (http:\/\/[^\s/]+)/.exec(plain(out))?.[1];
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

let model: Server;
interface ModelMessage {
  role: string;
  content: unknown;
}
/** The messages of every request OpenCode sent the stand-in model, oldest first. */
let requests: ModelMessage[][] = [];

/** A compaction summary in the template OpenCode 2 asks for; OpenCode retries a summary without its headings. */
const SUMMARY = ["Objective", "Requirements", "Decisions", "Work State", "Next Move", "Relevant Files", "Important Context"].map((h) => `## ${h}\n- SUMMARY-TEXT-5150`).join("\n\n");
/** What only the secret file the stand-in asks OpenCode to read holds: tool output, never conversation. */
const TOOL_OUTPUT = "TOOL-OUTPUT-7731";
const SECRET = "sk-live-abcdef1234567890";

/**
 * A local OpenAI-compatible model that records what it was sent. It answers "pong"; asked to "read
 * the secret file" it calls OpenCode's read tool on one, then answers "I read it"; asked for a
 * compaction summary it returns one.
 */
async function startModel(): Promise<number> {
  model = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += String(d)));
    req.on("end", () => {
      const sent = body ? (JSON.parse(body) as { messages?: ModelMessage[]; tools?: Array<{ function: { name: string } }> }) : {};
      if (body) requests.push(sent.messages ?? []);
      const last = sent.messages?.at(-1);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (choice: object, extra: object = {}) => res.write(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "stand-in", choices: [{ index: 0, ...choice }], ...extra })}\n\n`);
      const usage = { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
      const read = sent.tools?.find((t) => t.function.name === "read");
      if (last?.role === "user" && read && /read the secret file/.test(textOf(last))) {
        // The real path, as OpenCode sees its working folder: another spelling of it (macOS /var → /private/var) is outside and makes OpenCode ask first.
        chunk({ delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: JSON.stringify({ filePath: realpathSync(join(root, "work", "secret.txt")) }) } }] }, finish_reason: null });
        chunk({ delta: {}, finish_reason: "tool_calls" }, usage);
      } else {
        const reply = last?.role === "tool" ? "I read it" : /summarize the conversation|summary template/i.test(last ? textOf(last) : "") ? SUMMARY : "pong";
        chunk({ delta: { role: "assistant", content: reply }, finish_reason: null });
        chunk({ delta: {}, finish_reason: "stop" }, usage);
      }
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
  return (model.address() as { port: number }).port;
}

/** Text of one message as the model received it. */
const textOf = (m: ModelMessage) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b: { text?: string }) => b.text ?? "").join("") : "");
/** The Attache memory blocks in one request, wherever OpenCode put them in its system prompt. */
const memoryIn = (messages: ModelMessage[]) => messages.flatMap((m) => textOf(m).match(/<attache-memory>[\s\S]*?<\/attache-memory>/g) ?? []);
/** The last user message of a request; OpenCode 1's `run` sends a prompt wrapped in double quotes. */
const lastUser = (r: ModelMessage[]) => textOf([...r].reverse().find((m) => m.role === "user") ?? { role: "user", content: "" }).replace(/^"(.*)"$/s, "$1");

/** Run an OpenCode command without blocking this process, which also serves the stand-in model, and return what it printed. */
function opencodeAsync(args: string[], timeout = 90_000): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(OPENCODE!, args, { cwd: join(root, "work"), env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: process.platform === "win32" });
    let out = "";
    child.stdout!.on("data", (d) => (out += String(d)));
    child.stderr!.on("data", (d) => (out += String(d)));
    const timer = setTimeout(() => child.kill(), timeout);
    child.on("close", () => (clearTimeout(timer), resolve(plain(out))));
  });
}

/** Send one prompt to the running server, continuing the newest session unless `fresh`, and wait for the answer. */
async function prompt(url: string, text: string, fresh = false) {
  const out = await opencodeAsync(["run", major === 1 ? "--attach" : "--server", url, ...(fresh ? [] : ["--continue"]), text]);
  // OpenCode 1 prints no answer when attached to a server, so the stand-in's record is the proof the prompt ran.
  expect(requests.some((r) => lastUser(r) === text), `${out}\n${JSON.stringify(requests.map(lastUser))}`).toBe(true);
}

/** Compact the newest session and wait until OpenCode has stopped asking the model for its summary. */
async function compact(url: string) {
  const before = requests.length;
  if (major === 1) {
    const [session] = (await (await fetch(`${url}/session`)).json()) as Array<{ id: string }>;
    const r = await fetch(`${url}/session/${session!.id}/summarize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerID: "stand-in", modelID: "stand-in", auto: false }) });
    expect(r.ok).toBe(true);
  } else {
    const [session] = (JSON.parse(await opencodeAsync(["api", "session.list", "--server", url])) as { data: Array<{ id: string }> }).data;
    expect(await opencodeAsync(["api", "session.compact", "--param", `sessionID=${session!.id}`, "-d", "{}", "--server", url])).toMatch(/compaction/);
  }
  // OpenCode 2 retries a summary the stand-in cannot fill in; wait until the requests stop.
  await expect.poll(() => requests.length, { timeout: 30_000 }).toBeGreaterThan(before);
  for (let n = -1; n !== requests.length; ) {
    n = requests.length;
    await sleep(2_000);
  }
}

/** Save a project note and wait until the service has put it in the session context OpenCode's plugin reads. */
async function remember(title: string) {
  await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title, facts: [{ subject: "Status", value: `${title} is on track` }] }] });
  const file = join(svc.stateDir, "agents", "session-context.md");
  await expect.poll(() => (existsSync(file) ? readFileSync(file, "utf8") : "")).toContain(title);
}

/** Every byte OpenCode saved about its sessions: its database files and data folder. */
function savedByOpenCode(): string {
  const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)])) : []);
  return [...readdirSync(root).filter((f) => f.startsWith("opencode.db")).map((f) => join(root, f)), ...files(join(root, "data"))].map((f) => readFileSync(f, "latin1")).join("\n");
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
    // The stand-in model, as OpenCode's own configuration names it; Attache only reads this file.
    const port = await startModel();
    mkdirSync(join(root, "config", "opencode"), { recursive: true });
    const provider = { npm: "@ai-sdk/openai-compatible", name: "stand-in", options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "none" }, models: { "stand-in": { name: "stand-in" } } };
    writeFileSync(join(root, "config", "opencode", "opencode.json"), JSON.stringify({ provider: { "stand-in": provider }, model: "stand-in/stand-in", small_model: "stand-in/stand-in", permission: { read: "allow" } }));
    writeFileSync(join(root, "work", "secret.txt"), `# ${TOOL_OUTPUT}\nOPENAI_API_KEY=${SECRET}\n`);
    const version = opencode(["--version"]).trim();
    major = Number(/(\d+)\.\d+\.\d+/.exec(version)?.[1]);
    expect([1, 2], `opencode --version printed "${version}"`).toContain(major);
    svc = await startTestService({ stateDir: mkdtempSync(join(tmpdir(), "attache-opencode-smoke-state-")) });
    await svc.post("/setup/identity", { name: "Ada Lovelace", email: "ada@example.com", confirm: true });
  });
  afterAll(async () => {
    delete process.env.XDG_CONFIG_HOME;
    delete process.env.ATTACHE_OPENCODE_BIN;
    await new Promise((r) => model?.close(r));
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

  it("sends the Brain's current memory with every model call, fresh after a Brain change, a compaction and a resume, and never saves it", { timeout: 300_000 }, async () => {
    await remember("Orion migration");
    requests = [];
    let server = await serve();
    try {
      await prompt(server.url, "first question", true);
      await remember("Vega launch");
      await prompt(server.url, "second question");
      await compact(server.url);
      await remember("Lyra audit");
      await prompt(server.url, "after compaction");
    } finally {
      server.child.kill();
    }
    const prompts = ["first question", "second question", "after compaction"];
    const turns = prompts.map((p) => requests.find((r) => lastUser(r) === p)!);
    // One memory block per agent-loop call, holding the Brain's memory at that moment.
    expect(turns.map((r) => memoryIn(r).length)).toEqual([1, 1, 1]);
    expect(memoryIn(turns[0]!)[0]).toContain("Orion migration");
    expect(memoryIn(turns[0]!)[0]).not.toContain("Vega launch");
    expect(memoryIn(turns[1]!)[0]).toContain("Vega launch");
    expect(memoryIn(turns[2]!)[0]).toContain("Lyra audit");
    // OpenCode's compaction summary is written without Attache's memory, so it cannot carry old memory forward.
    const summaries = requests.filter((r) => /summar/i.test(r.map(textOf).join("\n")) && !prompts.includes(lastUser(r)));
    expect(summaries.length).toBeGreaterThan(0);
    for (const r of summaries) expect(memoryIn(r)).toEqual([]);

    await remember("Rigel handover");
    requests = [];
    server = await serve();
    try {
      await prompt(server.url, "resumed question");
    } finally {
      server.child.kill();
    }
    const resumed = requests.find((r) => lastUser(r) === "resumed question")!;
    expect(resumed.some((m) => textOf(m).includes("first question") || /summar/i.test(textOf(m)))).toBe(true);
    expect(memoryIn(resumed)).toHaveLength(1);
    expect(memoryIn(resumed)[0]).toContain("Rigel handover");

    const saved = savedByOpenCode();
    expect(saved).toContain("resumed question");
    expect(saved).not.toContain("attache-memory");
    expect(saved).not.toContain("Orion migration is on track");
  });

  it("saves the conversation at each turn's end, before and after a compaction and across a resume, without tool output, memory or the summary, and shuts down cleanly", { timeout: 300_000 }, async () => {
    await remember("Altair review");
    const prompts = ["capture one", "please read the secret file", "capture after compaction"];
    let server = await serve();
    try {
      await prompt(server.url, prompts[0]!, true);
      await prompt(server.url, prompts[1]!);
      await compact(server.url);
      await prompt(server.url, prompts[2]!);
    } finally {
      server.child.kill();
    }
    // OpenCode stops on its own when asked to, with the plugin's last save done.
    await expect.poll(() => server.child.exitCode !== null || server.child.signalCode !== null, { timeout: 15_000 }).toBe(true);
    server = await serve();
    try {
      await prompt(server.url, "capture resumed");
    } finally {
      server.child.kill();
    }
    await expect.poll(() => server.child.exitCode !== null || server.child.signalCode !== null, { timeout: 15_000 }).toBe(true);
    const dir = join(svc.dataDir, "evidence", "sessions", "transcripts", "opencode");
    const archive = () => (existsSync(dir) ? readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).find((d) => d.includes("capture one")) : undefined) ?? "";
    await expect.poll(archive, { timeout: 30_000 }).toContain("capture resumed");
    const doc = archive();
    // Every owner turn once, in order (OpenCode 1's `run` sends a prompt wrapped in double quotes).
    const owner = [...doc.matchAll(/^### Ada Lovelace[^\n]*\n\n"?([^"\n]*)"?$/gm)].map((m) => m[1]);
    expect(owner).toEqual([...prompts, "capture resumed"]);
    // The stand-in only answers "I read it" once OpenCode ran its read tool and sent back what it read.
    expect(doc, JSON.stringify(requests.map((r) => r.map((m) => m.role).join(",")))).toContain("I read it");
    for (const leaked of [TOOL_OUTPUT, SECRET, "attache-memory", "Altair review is on track", "SUMMARY-TEXT-5150"]) expect(doc).not.toContain(leaked);
    // Nothing half-written is left in the spool, and the summariser's input is just as clean.
    expect(readdirSync(join(svc.stateDir, "agents", "spool")).filter((f) => f.startsWith("."))).toEqual([]);
    const cache = readdirSync(join(svc.stateDir, "agents", "sessions", "opencode")).map((f) => readFileSync(join(svc.stateDir, "agents", "sessions", "opencode", f), "utf8")).join("\n");
    for (const leaked of [TOOL_OUTPUT, SECRET, "attache-memory", "SUMMARY-TEXT-5150"]) expect(cache).not.toContain(leaked);
  });

  it("leaves OpenCode with no Attache plugin or server after disconnecting", { timeout: 180_000 }, async () => {
    const d = await svc.post<{ harness: { failures: string[] } }>("/connections/opencode/disconnect", { deleteData: false });
    expect(d.harness.failures).toEqual([]);
    expect(readdirSync(plugins()).filter((f) => f.startsWith("attache"))).toEqual([]);
    const servers = await mcpServers(null);
    expect(Object.keys(servers).filter((n) => n.startsWith("attache"))).toEqual([]);
    requests = [];
    const server = await serve();
    try {
      await prompt(server.url, "after disconnecting", true);
    } finally {
      server.child.kill();
    }
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(memoryIn(r)).toEqual([]);
  });
});
