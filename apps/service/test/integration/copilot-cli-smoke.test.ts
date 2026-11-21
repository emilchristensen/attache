import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { callTool, mcpClients } from "./mcp-client.ts";
import { contextFile, listSpool } from "../../src/agents/spool.ts";

/**
 * Smoke test against the real Copilot CLI executable, in an isolated home: after Attache connects
 * Copilot CLI, the real `copilot mcp list` / `copilot mcp get` load Attache's server from the
 * personal MCP configuration (source "user", enabled) next to the owner's own server, and the
 * server Copilot CLI reports starts and reaches the Brain; after disconnecting, Copilot CLI lists
 * no Attache server and still lists the owner's. It runs only where `copilot` is on PATH (or
 * `ATTACHE_COPILOT_EXECUTABLE` names it) and is skipped otherwise.
 *
 * Memory: real Copilot CLI sessions run against a local stand-in model, through Copilot CLI's own
 * offline mode with a custom model provider (COPILOT_OFFLINE, COPILOT_PROVIDER_BASE_URL), which
 * needs no GitHub sign-in. The stand-in records what Copilot CLI sends it, which shows that Attache's
 * personal session-start hook puts the current memory, once, in a new session, a resumed one and
 * (where python3 can drive the interactive terminal) one started by /clear; that the memory is not
 * stored as a conversation message in the session's events.jsonl; and that after disconnecting a
 * new session gets none.
 *
 * Capture: the stand-in makes a session read a secret-bearing file with Copilot CLI's view tool;
 * Attache's agentStop and sessionEnd hooks copy the session's events.jsonl and the service archives
 * only the owner's and Copilot CLI's words, never the file's text; a resumed session's turns join the
 * same conversation once each; /compact (where python3 can drive the terminal) saves the conversation
 * before compacting and summarises it straight away; after disconnecting nothing is copied.
 *
 * It needs no GitHub sign-in, and runs with none: every token variable is removed and `gh` gets an
 * empty config folder. It does not show the name Copilot CLI's MCP client gives itself.
 *
 * ADR 0006: Attache may call Copilot CLI's MCP access, memory and session capture officially
 * supported only while this passes, for the Copilot CLI versions it ran against; a failure here
 * withdraws that claim for Copilot CLI only (a failing capture case, the capture claim only).
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
let model: Server;
let modelUrl: string;
interface ModelMessage {
  role: string;
  content: unknown;
}
/** The messages of every request Copilot CLI sent the stand-in model, oldest first. */
const requests: ModelMessage[][] = [];

/** A local OpenAI-compatible model that answers every request with "pong" and records what it was sent. */
async function startModel(): Promise<string> {
  model = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += String(d)));
    req.on("end", () => {
      if (req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "stand-in", object: "model" }] }));
      }
      const request = body ? (JSON.parse(body) as { messages?: ModelMessage[]; tools?: Array<{ function?: { name?: string } }> }) : {};
      const messages = request.messages ?? [];
      if (body) requests.push(messages);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (choice: object, extra: object = {}) => res.write(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "stand-in", choices: [{ index: 0, ...choice }], ...extra })}\n\n`);
      // Asked to read the secret file, it first reads it with Copilot CLI's view tool, then answers without repeating it.
      const last = messages[messages.length - 1];
      if (last?.role === "user" && textOf(last).includes(READ_SECRET) && request.tools?.some((t) => t.function?.name === "view")) {
        chunk({ delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: "view", arguments: "" } }] }, finish_reason: null });
        chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: secretFile }) } }] }, finish_reason: null });
        chunk({ delta: {}, finish_reason: "tool_calls" }, { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
        return res.end("data: [DONE]\n\n");
      }
      chunk({ delta: { role: "assistant", content: last?.role === "tool" ? "I read the file and left it alone." : "pong" }, finish_reason: null });
      chunk({ delta: {}, finish_reason: "stop" }, { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
}

/** What a prompt says to make the stand-in read the secret file with a tool. */
const READ_SECRET = "READ-THE-NOTES";
/** Plain text only the secret file holds, which redaction never rewrites. */
const TOOL_OUTPUT = "TOOL-OUTPUT-5521";
const SECRET = "sk-live-abcdef1234567890";
let secretFile: string;

const textOf = (m: ModelMessage) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b: { text?: string }) => b.text ?? "").join("") : "");
/** The Attache memory blocks in one request to the model. */
const memoryIn = (messages: ModelMessage[]) => messages.flatMap((m) => textOf(m).match(/<attache-memory>[\s\S]*?<\/attache-memory>/g) ?? []);
/** The request whose newest user message ends with `prompt`. */
const requestFor = (prompt: string) => requests.find((r) => textOf([...r].reverse().find((m) => m.role === "user") ?? { role: "user", content: "" }).trim().endsWith(prompt));

/** Copilot CLI's environment for a session against the stand-in model, signed in to nothing. */
const sessionEnv = () => ({ ...env, COPILOT_OFFLINE: "true", COPILOT_PROVIDER_BASE_URL: modelUrl, COPILOT_PROVIDER_TYPE: "openai", COPILOT_PROVIDER_API_KEY: "stand-in", COPILOT_MODEL: "stand-in" });

/** Run `copilot -p` without blocking this process, which also serves the stand-in model; returns the session id it printed. */
function promptSession(prompt: string, resume?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [...(resume ? [`--resume=${resume}`] : []), "-p", prompt, "--no-color", "--no-auto-update", "--allow-all-tools"];
    const child = spawn(COPILOT!, args, { cwd: join(root, "work"), env: sessionEnv(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: process.platform === "win32" });
    let out = "";
    child.stdout!.on("data", (d) => (out += String(d)));
    child.stderr!.on("data", (d) => (out += String(d)));
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      const id = /--resume=([0-9a-f-]{36})/.exec(out)?.[1];
      if (code !== 0 || !id) reject(new Error(`copilot ${args.join(" ")} exited ${code}:\n${out}`));
      else resolve(id);
    });
  });
}

/** Every event in a session's events.jsonl, as Copilot CLI wrote it. */
const sessionEvents = (id: string) => readFileSync(join(root, "copilot", "session-state", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; data?: unknown });

/**
 * Drives Copilot CLI's interactive terminal, which Node cannot open: each line on stdin is typed, and
 * the line "<enter>" presses Enter (sent apart from the text, which the terminal would otherwise
 * take as a paste); "ready" is printed once the prompt's footer ("? help", once colour codes are
 * removed) shows; stdin closing ends
 * it. It never waits on a clock.
 */
const PTY_DRIVER = `
import os, pty, sys, select, fcntl, termios, struct, re
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
ready = False
seen = b""
while True:
    r, _, _ = select.select([fd, 0], [], [])
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        if not ready:
            seen = (seen + data)[-4096:]
            if b"? help" in re.sub(rb"\\x1b(\\[[0-9;?<>=$]*[A-Za-z~]|\\][^\\x07\\x1b]*(\\x07|\\x1b\\\\\\\\)|.)", b"", seen):
                ready = True
                sys.stdout.write("ready\\n"); sys.stdout.flush()
    if 0 in r:
        line = sys.stdin.readline()
        if not line:
            break
        text = line.rstrip("\\n")
        os.write(fd, b"\\r" if text == "<enter>" else text.encode())
os.kill(pid, 9)
`;
type Type = (line: string) => Promise<void>;
/**
 * Run an interactive Copilot CLI against the stand-in model through the PTY driver: `steps` types
 * lines and waits for the model to be asked about them; closing the terminal afterwards ends the
 * session the way closing a terminal window does.
 */
async function interactive(args: string[], steps: (type: Type, answered: (prompt: string) => Promise<void>) => Promise<void>) {
  const driver = join(root, "pty-driver.py");
  writeFileSync(driver, PTY_DRIVER);
  const before = requests.length;
  // COPILOT_ALLOW_ALL=true trusts the working folder, so no trust question takes the first keystrokes.
  const child = spawn(PYTHON!, [driver, COPILOT!, "--no-color", "--no-auto-update", ...args], { cwd: join(root, "work"), env: { ...sessionEnv(), COPILOT_ALLOW_ALL: "true" }, stdio: ["pipe", "pipe", "ignore"] });
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  try {
    await new Promise<void>((resolve) => child.stdout!.on("data", (d) => String(d).includes("ready") && resolve()));
    // The footer shows before the session takes input; give it a moment.
    await new Promise((r) => setTimeout(r, 5_000));
    const type = async (line: string) => {
      child.stdin!.write(`${line}\n`);
      await new Promise((r) => setTimeout(r, 500));
      child.stdin!.write("<enter>\n");
    };
    const answered = async (prompt: string) => {
      await expect.poll(() => requests.slice(before).some((r) => textOf(r[r.length - 1]!).trim().endsWith(prompt)), { timeout: 60_000, interval: 250 }).toBe(true);
    };
    await steps(type, answered);
  } finally {
    child.stdin!.end();
    await closed;
  }
}

/** The conversation Attache archived for a Copilot CLI session, or null. */
const archived = (id: string) => {
  const dir = join(svc.dataDir, "evidence/sessions/transcripts/copilot-cli");
  const f = existsSync(dir) ? readdirSync(dir).find((x) => x.includes(id)) : undefined;
  return f ? readFileSync(join(dir, f), "utf8") : null;
};
/** An archived conversation's turns, as "Speaker: text", in order. */
const turnsOf = (doc: string) => [...doc.matchAll(/^### (Ada Lovelace|Copilot CLI)[^\n]*\n\n([^\n]*)/gm)].map((m) => `${m[1]}: ${m[2]}`);
const summaryJobs = (id: string) =>
  (svc.app.db.prepare("select id from jobs where kind = 'session-distill' and json_extract(input, '$.sessionId') = ?").all(id) as Array<{ id: string }>).map((r) => svc.app.jobs.get(r.id)!);
const spoolSettled = () => expect.poll(() => listSpool(svc.stateDir).length, { timeout: 30_000, interval: 200 }).toBe(0);

const PYTHON = process.platform === "win32" ? null : spawnSync("python3", ["--version"]).status === 0 ? "python3" : null;
let root: string;
let sessionId: string;
let captured: string;
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
    // Copilot CLI's tools see the folder's real path (/private/var on macOS).
    secretFile = join(realpathSync(join(root, "work")), "notes.env");
    writeFileSync(secretFile, `# ${TOOL_OUTPUT}\nOPENAI_API_KEY=${SECRET}\n`);
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
    // Attache's version check asks this executable.
    process.env.ATTACHE_COPILOT_BIN = COPILOT!;
    const version = copilot(["--version"]).out;
    expect(version, `copilot --version printed "${version}"`).toMatch(/\d+\.\d+\.\d+/);
    modelUrl = await startModel();
    svc = await startTestService({ stateDir: mkdtempSync(join(tmpdir(), "attache-copilot-smoke-state-")) });
    await svc.post("/setup/identity", { name: "Ada Lovelace", email: "ada@example.com", confirm: true });
    await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned for the first weekend of December" }] }] });
  });
  afterAll(async () => {
    delete process.env.COPILOT_HOME;
    delete process.env.ATTACHE_COPILOT_BIN;
    await mcp.closeAll();
    await svc?.stop();
    await new Promise((r) => (model ? model.close(r) : r(null)));
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

  it("a new session starts with the current memory, once, as a message of its own", { timeout: 120_000 }, async () => {
    const id = await promptSession("first question");
    const request = requestFor("first question");
    expect(request, JSON.stringify(requests)).toBeDefined();
    const memory = memoryIn(request!);
    expect(memory).toHaveLength(1);
    expect(memory[0]).toMatch(/Orion migration/);
    expect(request!.some((m) => m.role === "user" && textOf(m).trim().startsWith("<attache-memory>"))).toBe(true);
    // Copilot CLI records the hook's output on its hook.end event, not as a conversation message (what a capture parser reads).
    const events = sessionEvents(id);
    const carrying = events.filter((e) => JSON.stringify(e).includes("attache-memory")).map((e) => e.type);
    expect(carrying).toEqual(["hook.end"]);
    expect(events.filter((e) => /^(user|assistant|system)\.message$/.test(e.type)).some((e) => JSON.stringify(e).includes("Orion migration"))).toBe(false);
    sessionId = id;
  });

  it("a resumed session gets today's memory, and no copy of the memory it started with", { timeout: 120_000 }, async () => {
    await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Vega launch", facts: [{ subject: "Status", value: "Launch review on Thursday" }] }] });
    await expect.poll(() => (existsSync(contextFile(svc.stateDir)) ? readFileSync(contextFile(svc.stateDir), "utf8") : "")).toMatch(/Vega launch/);
    await promptSession("second question", sessionId);
    const memory = memoryIn(requestFor("second question")!);
    expect(memory).toHaveLength(1);
    expect(memory[0]).toMatch(/Vega launch/);
  });

  it.skipIf(!PYTHON)("a session started by /clear in a running Copilot CLI gets today's memory", { timeout: 180_000 }, async () => {
    const before = requests.length;
    await interactive([], async (type, answered) => {
      await type("before clearing");
      await answered("before clearing");
      await type("/clear");
      await new Promise((r) => setTimeout(r, 3_000));
      await type("after clearing");
      await answered("after clearing");
    });
    const after = requests.slice(before);
    const first = after.find((r) => textOf(r[r.length - 1]!).trim().endsWith("before clearing"));
    const cleared = after.find((r) => textOf(r[r.length - 1]!).trim().endsWith("after clearing"));
    expect(first && cleared, JSON.stringify(after.map((r) => textOf(r[r.length - 1]!).slice(-40)))).toBeTruthy();
    // The cleared session carries none of the old conversation, and its own copy of the memory.
    expect(cleared!.some((m) => textOf(m).includes("before clearing"))).toBe(false);
    expect(memoryIn(cleared!)).toHaveLength(1);
    expect(memoryIn(cleared!)[0]).toMatch(/Vega launch/);
  });

  it("saves a session's conversation after the turn and at its end, from events.jsonl, without the tool output it read", { timeout: 120_000 }, async () => {
    captured = await promptSession(`Look at the notes ${READ_SECRET}`);
    // The stand-in really made Copilot CLI read the secret file with its view tool.
    expect(sessionEvents(captured).some((e) => e.type === "tool.execution_complete" && JSON.stringify(e.data).includes(TOOL_OUTPUT))).toBe(true);
    await expect.poll(() => archived(captured), { timeout: 30_000, interval: 200 }).toBeTruthy();
    const doc = archived(captured)!;
    expect(turnsOf(doc)).toEqual([`Ada Lovelace: Look at the notes ${READ_SECRET}`, "Copilot CLI: I read the file and left it alone."]);
    const cache = readFileSync(join(svc.stateDir, "agents/sessions/copilot-cli", `${captured}.json`), "utf8");
    for (const text of [doc, cache]) for (const marker of [TOOL_OUTPUT, SECRET, "attache-memory", "Orion migration", "Vega launch"]) expect(text).not.toContain(marker);
  });

  it("a resumed session's new turns join its conversation, each turn once", { timeout: 120_000 }, async () => {
    await promptSession("capture follow-up", captured);
    await expect.poll(() => archived(captured), { timeout: 30_000, interval: 200 }).toMatch(/capture follow-up[\s\S]*pong/);
    expect(turnsOf(archived(captured)!)).toEqual([`Ada Lovelace: Look at the notes ${READ_SECRET}`, "Copilot CLI: I read the file and left it alone.", "Ada Lovelace: capture follow-up", "Copilot CLI: pong"]);
  });

  it.skipIf(!PYTHON)("saves the conversation before /compact compacts it, and the turns after it, when the terminal closes", { timeout: 180_000 }, async () => {
    await spoolSettled();
    // Every boundary so far was a turn end or a session end; record which summaries ran.
    const ran = () => summaryJobs(captured).filter((j) => j.status === "succeeded").length;
    const ranBefore = ran();
    await interactive([`--resume=${captured}`], async (type, answered) => {
      await type("before compacting");
      await answered("before compacting");
      await type("/compact");
      await expect.poll(() => sessionEvents(captured).some((e) => e.type === "session.compaction_complete"), { timeout: 60_000, interval: 250 }).toBe(true);
      // The compaction's spooled copy is summarised straight away, unlike a turn end's, which waits for quiet.
      await expect.poll(ran, { timeout: 30_000, interval: 250 }).toBeGreaterThan(ranBefore);
      expect(turnsOf(archived(captured)!).at(-1)).toBe("Copilot CLI: pong");
      expect(archived(captured)).toContain("before compacting");
      await type("after compacting");
      await answered("after compacting");
    });
    await spoolSettled();
    await expect.poll(() => archived(captured), { timeout: 30_000, interval: 200 }).toContain("after compacting");
    expect(turnsOf(archived(captured)!)).toEqual([
      `Ada Lovelace: Look at the notes ${READ_SECRET}`,
      "Copilot CLI: I read the file and left it alone.",
      "Ada Lovelace: capture follow-up",
      "Copilot CLI: pong",
      "Ada Lovelace: before compacting",
      "Copilot CLI: pong",
      "Ada Lovelace: after compacting",
      "Copilot CLI: pong",
    ]);
    for (const marker of [TOOL_OUTPUT, SECRET, "attache-memory"]) expect(archived(captured)).not.toContain(marker);
  });

  it("lists no Attache server, and still the owner's, after disconnecting, and a new session gets no memory", { timeout: 120_000 }, async () => {
    const d = await svc.post<{ harness: { failures: string[] } }>("/connections/copilot-cli/disconnect", { deleteData: false });
    expect(d.harness.failures).toEqual([]);
    expect(Object.keys(userServers())).toEqual(["playwright"]);
    expect(readFileSync(join(root, "copilot", "mcp-config.json"), "utf8")).not.toMatch(/attache/);
    expect(readdirSync(join(root, "copilot", "hooks"))).toEqual([]);
    const after = await promptSession("after disconnecting");
    expect(memoryIn(requestFor("after disconnecting")!)).toEqual([]);
    // Nor is it saved: no hook copies it.
    expect(listSpool(svc.stateDir).filter((r) => r.sessionId === after)).toEqual([]);
    expect(archived(after)).toBeNull();
  });
});
