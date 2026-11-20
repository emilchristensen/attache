import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";

/**
 * Smoke test against the real Pi executable, in an isolated Pi agent folder: connecting Pi through
 * Attache makes the real Pi register and connect Attache's MCP server and send the Brain's current
 * memory with each model call, without saving it in the session, and disconnecting leaves Pi with no
 * Attache server and no memory. The model is a local stand-in that records what Pi sends it, so no
 * model account is needed. It runs only where `pi` is on PATH (or `ATTACHE_PI_EXECUTABLE` names it)
 * and is skipped otherwise.
 *
 * ADR 0006: Attache may call Pi's MCP access officially supported only while this passes; a failure
 * here withdraws that claim for Pi only.
 */

function findPi(): string | null {
  if (process.env.ATTACHE_PI_EXECUTABLE) return process.env.ATTACHE_PI_EXECUTABLE;
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const name of ["pi", "pi.cmd", "pi.exe"]) if (existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}
const PI = findPi();

/**
 * A test-only extension, loaded next to Attache's with `-e`: once the session has started it waits
 * for the named server's tools (or briefly, when none is named), then writes the MCP servers and
 * tools Pi has to a file. It never blocks Pi's own session start.
 */
const PROBE = `import { writeFileSync } from "node:fs";
export default function probe(pi) {
  pi.on("session_start", () => {
    void (async () => {
      // Pi namespaces a server's tools as mcp__<server>, with "-" in the server name turned into "_".
      const server = process.env.ATTACHE_PI_PROBE_SERVER;
      const deadline = Date.now() + (server ? 30000 : 3000);
      const tools = () => pi.getAllTools().filter((t) => t.namespace && t.namespace.name.startsWith("mcp__")).map((t) => ({ namespace: t.namespace.name, name: t.name }));
      while (Date.now() < deadline && !(server && tools().some((t) => t.namespace === "mcp__" + server.replace(/-/g, "_")))) await new Promise((r) => setTimeout(r, 250));
      const servers = pi.getMcpServers().map((s) => ({ name: s.name, extensionPath: s.extensionPath }));
      writeFileSync(process.env.ATTACHE_PI_PROBE_OUT, JSON.stringify({ servers, tools: tools() }));
    })();
  });
}
`;

interface Probe {
  servers: Array<{ name: string; extensionPath: string }>;
  /** MCP tools only, by Pi's namespace for their server. */
  tools: Array<{ namespace: string; name: string }>;
}

let svc: TestService;
let work: string;
let agentDir: string;
let model: Server;
/** The messages of every request Pi sent the stand-in model, oldest first. */
let requests: Array<Array<{ role: string; content: unknown }>> = [];

/** A local OpenAI-compatible model that answers every request with "pong" and records what it was sent. */
async function startModel(): Promise<number> {
  model = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += String(d)));
    req.on("end", () => {
      requests.push((JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> }).messages);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (choice: object, extra: object = {}) => res.write(`data: ${JSON.stringify({ id: "r", object: "chat.completion.chunk", created: 1, model: "stand-in", choices: [{ index: 0, ...choice }], ...extra })}\n\n`);
      chunk({ delta: { role: "assistant", content: "pong" }, finish_reason: null });
      chunk({ delta: {}, finish_reason: "stop" }, { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
  return (model.address() as { port: number }).port;
}

/** A test-only extension that gives Pi the stand-in model. */
const modelExtension = (port: number) => `export default function standIn(pi) {
  pi.registerProvider("stand-in", { baseUrl: "http://127.0.0.1:${port}/v1", apiKey: "none", api: "openai-completions",
    models: [{ id: "stand-in", name: "stand-in", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1000 }] });
}
`;

/** Text of one message as the model received it. */
const textOf = (m: { content: unknown }) => (typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((b: { text?: string }) => b.text ?? "").join("") : "");
/** The Attache memory blocks in one request. */
const memoryIn = (messages: Array<{ role: string; content: unknown }>) => messages.map(textOf).filter((t) => t.includes("<attache-memory>"));

/**
 * Drive the real Pi in RPC mode through prompts and commands, each waiting until Pi has settled or
 * answered, then stop Pi. `resume` continues the newest session instead of starting one.
 */
async function drivePi(steps: Array<{ prompt: string } | { compact: true } | { before: () => Promise<void> }>, opts: { resume?: boolean } = {}) {
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  const args = ["--mode", "rpc", "-e", join(work, "model.ts"), "--model", "stand-in/stand-in", "--session-dir", join(work, "sessions"), ...(opts.resume ? ["-c"] : [])];
  const child = spawn(PI!, args, { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += String(d)));
  let buffer = "";
  const waiting: Array<{ match: (o: Record<string, unknown>) => boolean; done: (o: Record<string, unknown>) => void }> = [];
  child.stdout.on("data", (d) => {
    buffer += String(d);
    for (let i = buffer.indexOf("\n"); i >= 0; i = buffer.indexOf("\n")) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const w of [...waiting]) {
        if (!w.match(o)) continue;
        waiting.splice(waiting.indexOf(w), 1);
        w.done(o);
      }
    }
  });
  const until = (match: (o: Record<string, unknown>) => boolean) =>
    new Promise<Record<string, unknown>>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`pi did not answer within 60 s: ${stderr}`)), 60_000);
      waiting.push({ match, done: (o) => (clearTimeout(timer), done(o)) });
    });
  const send = (o: object) => child.stdin.write(JSON.stringify(o) + "\n");
  try {
    for (const step of steps) {
      if ("before" in step) await step.before();
      else if ("prompt" in step) {
        const settled = until((o) => o.type === "agent_settled");
        send({ type: "prompt", message: step.prompt });
        await settled;
      } else {
        const answered = until((o) => o.id === "compact");
        send({ id: "compact", type: "compact" });
        expect(await answered).toMatchObject({ success: true });
      }
    }
  } finally {
    child.kill();
  }
}

/** Save a project note and wait until the service has put it in the session context Pi reads. */
async function remember(title: string) {
  await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title, facts: [{ subject: "Status", value: `${title} is on track` }] }] });
  await expect.poll(() => (existsSync(join(svc.stateDir, "agents", "session-context.md")) ? readFileSync(join(svc.stateDir, "agents", "session-context.md"), "utf8") : "")).toContain(title);
}

/** Every line of every Pi session file. */
const sessionText = () => readdirSync(join(work, "sessions")).map((f) => readFileSync(join(work, "sessions", f), "utf8")).join("\n");

/** Start the real Pi with the probe, wait for its report, and stop Pi. */
async function runPi(server: string | null): Promise<Probe> {
  const out = join(work, `probe-${Date.now()}.json`);
  const probe = join(work, "probe.ts");
  writeFileSync(probe, PROBE);
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", ATTACHE_PI_PROBE_OUT: out, ATTACHE_PI_PROBE_SERVER: server ?? "" };
  const child = spawn(PI!, ["--mode", "rpc", "--no-session", "-e", probe], { cwd: work, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += String(d)));
  try {
    const deadline = Date.now() + 60_000;
    while (!existsSync(out)) {
      if (child.exitCode !== null) throw new Error(`pi exited with ${child.exitCode} before the probe reported: ${stderr}`);
      if (Date.now() > deadline) throw new Error(`pi did not report its MCP servers within 60 s: ${stderr}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    return JSON.parse(readFileSync(out, "utf8")) as Probe;
  } finally {
    child.kill();
  }
}

describe.skipIf(!PI)("the real Pi executable", () => {
  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "attache-pi-smoke-"));
    agentDir = join(work, "agent");
    // Both Attache and Pi use this agent folder, so the owner's real ~/.pi is never touched.
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(join(work, "model.ts"), modelExtension(await startModel()));
    mkdirSync(join(work, "sessions"));
    // Keep almost nothing on compaction, so a two-prompt session can be compacted.
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 1 } }));
    svc = await startTestService({ stateDir: mkdtempSync(join(tmpdir(), "attache-pi-smoke-state-")) });
    await svc.post("/setup/identity", { name: "Ada Lovelace", email: "ada@example.com", confirm: true });
  });
  afterAll(async () => {
    delete process.env.PI_CODING_AGENT_DIR;
    await new Promise((r) => model?.close(r));
    await svc?.stop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  // Each case starts the real Pi and Attache's MCP server, which together take far longer than a unit test.
  it("registers and connects Attache's MCP server once Attache connects Pi", { timeout: 120_000 }, async () => {
    await svc.post("/connections/pi/configure", { method: "mcp", fields: {} });
    const [file] = readdirSync(join(agentDir, "extensions"));
    const server = file!.replace(/\.ts$/, "");
    const r = await runPi(server);
    expect(r.servers).toEqual([{ name: server, extensionPath: join(agentDir, "extensions", file!) }]);
    const ours = r.tools.filter((t) => t.namespace === `mcp__${server.replace(/-/g, "_")}`);
    expect(ours.map((t) => t.name)).toEqual(expect.arrayContaining([expect.stringMatching(/search$/)]));
  });

  it("sends the Brain's current memory with every model call, fresh after a Brain change, a compaction and a resume, and never saves it in the session", { timeout: 180_000 }, async () => {
    await remember("Orion migration");
    requests = [];
    await drivePi([{ prompt: "first question" }, { before: () => remember("Vega launch") }, { prompt: "second question" }, { compact: true }, { before: () => remember("Lyra audit") }, { prompt: "after compaction" }]);
    // A request for a prompt ends with that prompt; Pi's compaction asks the model for summaries in requests of its own.
    const prompts = ["first question", "second question", "after compaction"];
    const last = (r: Array<{ content: unknown }>) => textOf(r[r.length - 1]!);
    const turns = requests.filter((r) => prompts.includes(last(r)));
    // One memory block per model call, ahead of the conversation, and only the Brain's memory at that moment.
    expect(turns.map((r) => [last(r), memoryIn(r).length])).toEqual(prompts.map((p) => [p, 1]));
    expect(memoryIn(turns[0]!)[0]).toContain("Orion migration");
    expect(memoryIn(turns[0]!)[0]).not.toContain("Vega launch");
    expect(memoryIn(turns[1]!)[0]).toContain("Vega launch");
    expect(memoryIn(turns[2]!)[0]).toContain("Lyra audit");
    expect(turns[2]!.some((m) => textOf(m).includes("<summary>"))).toBe(true);
    // Pi's compaction summary is written without Attache's memory, so it cannot carry old memory forward.
    const summaries = requests.filter((r) => !prompts.includes(last(r)));
    expect(summaries.length).toBeGreaterThan(0);
    for (const r of summaries) expect(memoryIn(r)).toEqual([]);

    await remember("Rigel handover");
    requests = [];
    await drivePi([{ prompt: "resumed question" }], { resume: true });
    const resumed = requests.find((r) => r.some((m) => textOf(m) === "resumed question"))!;
    expect(resumed.some((m) => textOf(m) === "first question" || textOf(m).includes("<summary>"))).toBe(true);
    expect(memoryIn(resumed)).toHaveLength(1);
    expect(memoryIn(resumed)[0]).toContain("Rigel handover");

    const saved = sessionText();
    expect(saved).toContain("resumed question");
    expect(saved).not.toContain("attache-memory");
    expect(saved).not.toContain("Orion migration is on track");
  });

  it("leaves Pi with no Attache server and no Attache memory after disconnecting", { timeout: 120_000 }, async () => {
    const d = await svc.post<{ harness: { failures: string[] } }>("/connections/pi/disconnect", { deleteData: false });
    expect(d.harness.failures).toEqual([]);
    expect(readdirSync(join(agentDir, "extensions"))).toEqual([]);
    const r = await runPi(null);
    expect(r.servers.filter((s) => s.name.startsWith("attache"))).toEqual([]);
    expect(r.tools.filter((t) => t.namespace.startsWith("mcp__attache"))).toEqual([]);
    requests = [];
    await drivePi([{ prompt: "after disconnecting" }]);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(memoryIn(r)).toEqual([]);
  });
});
