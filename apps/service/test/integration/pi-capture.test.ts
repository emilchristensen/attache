import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { installFixtureModel } from "../fixtures/fixture-model.ts";
import { HEADER, MEMORY, SECRET, SIDE, TOOL_OUTPUT, assistant, compaction, entry, normal, text, user } from "../fixtures/agents/pi.ts";
import { spoolDir, spoolText } from "../../src/agents/spool.ts";

/**
 * Saving Pi sessions through the real service: Attache's Pi extension, loaded the way Pi loads it,
 * spools the session's branch when Pi settles after a run, before a compaction and when the
 * session closes; the service archives one conversation of the owner's and the assistant's words
 * per session and summarises that, never tool output, injected memory or a subagent's output.
 */

const HOME = process.env.ATTACHE_AGENT_HOME!;
const EXTENSIONS = join(HOME, ".pi/agent/extensions");

let svc: TestService;
let fx: FixtureServer;

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>;
/** Pi hosting Attache's extension for one session whose branch the test sets. */
async function piSession(header: Record<string, unknown> = HEADER) {
  const [file] = readdirSync(EXTENSIONS).filter((f) => f.startsWith("attache"));
  const handlers = new Map<string, Handler[]>();
  const mod = (await import(`${join(EXTENSIONS, file!)}?v=${Math.random()}`)) as { default: (api: unknown) => void };
  mod.default({ registerMcpServer: () => {}, on: (event: string, h: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), h]) });
  const session = { branch: [] as unknown[] };
  const ctx = { cwd: HOME, sessionManager: { getSessionFile: () => join(HOME, "s.jsonl"), getSessionId: () => header.id, getHeader: () => header, getBranch: () => session.branch } };
  const emit = async (event: string, payload: object = {}) => {
    for (const h of handlers.get(event) ?? []) await h({ type: event, ...payload }, ctx);
  };
  return { session, settles: () => emit("agent_settled", { aborted: false }), compacts: () => emit("session_before_compact", { reason: "manual" }), quits: () => emit("session_shutdown", { reason: "quit" }) };
}

async function until<T>(fn: () => T | undefined | null | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}
const spoolEmpty = () => until(() => !readdirSync(spoolDir(svc.stateDir)).some((f) => f.endsWith(".json")));
const archiveDir = () => join(svc.dataDir, "evidence/sessions/transcripts/pi");
const archived = (sessionId: string) => {
  const f = existsSync(archiveDir()) ? readdirSync(archiveDir()).find((x) => x.includes(sessionId)) : undefined;
  return f ? readFileSync(join(archiveDir(), f), "utf8") : null;
};
/** The headings of an archived conversation's turns and their text, in order. */
const turnsOf = (doc: string) => [...doc.matchAll(/^### (\S+)[^\n]*\n\n([^\n]*)/gm)].map((m) => `${m[1]}: ${m[2]}`);
const cacheOf = (sessionId: string) => readFileSync(join(svc.stateDir, "agents/sessions/pi", `${sessionId.replace(/[^A-Za-z0-9_-]/g, "")}.json`), "utf8");
const jobsFor = (sessionId: string) =>
  (svc.app.db.prepare("select id from jobs where kind = 'session-distill' and json_extract(input, '$.sessionId') = ?").all(sessionId) as Array<{ id: string }>).map((r) => svc.app.jobs.get(r.id)!);
const warnings = () =>
  readFileSync(join(svc.stateDir, "logs/service.log"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { level: string; msg: string; data?: Record<string, unknown> })
    .filter((e) => e.level === "warn");

beforeAll(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  fx = await startFixtureServer();
  installFixtureModel(fx);
  svc = await startTestService({ stateDir: mkdtempSync(join(tmpdir(), "attache-it-pi-capture-")) });
  await svc.post("/setup/identity", { name: "Ada", email: "ada@example.com", confirm: true });
  await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "On track" }] }] });
  await svc.post("/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${fx.url}/model`, model: "fixture-model" } });
  await svc.post("/connections/pi/configure", { method: "hooks", fields: {} });
  // The extension spools only while the service keeps the session context, which it writes once it has started.
  await until(() => existsSync(join(svc.stateDir, "agents/session-context.md")));
});
afterAll(async () => {
  await svc?.stop();
  await fx?.close();
});

describe("Pi session capture", () => {
  it("is offered as capture with a final event, and the Connection says only a session Pi is killed in can lose its newest turn", async () => {
    const def = (await svc.get<{ definitions: Array<{ kind: string; description?: string; setupHelp?: string; harness?: { capabilities: { capture: string } } }> }>("/capabilities")).definitions.find((d) => d.kind === "pi")!;
    expect(def.harness!.capabilities.capture).toBe("with-final-event");
    expect(def.description).toMatch(/save your Pi sessions/);
    expect(def.setupHelp).toMatch(/newest turn/);
  });

  it("turns before and after a compaction, then a resume, are saved as one conversation, without tool output, memory, side-chains or the summary", async () => {
    const pi = await piSession();
    const before = [entry("custom_message", 0, { customType: "attache-memory", content: `<attache-memory>\n${MEMORY}\n</attache-memory>`, display: false }), ...normal()];
    pi.session.branch = before.slice(0, 6);
    await pi.settles();
    await spoolEmpty();
    pi.session.branch = before;
    await pi.compacts();
    await spoolEmpty();
    const subagent = entry("message", 12, { message: { role: "toolResult", toolCallId: "c2", toolName: "subagent", content: [{ type: "text", text: `Subagent: ${SIDE}` }], isError: false, timestamp: 1 } });
    pi.session.branch = [...before, compaction(10, before[9]!.id), user("Ship it on Saturday", 11), subagent, assistant([text("Booked for Saturday.")], 13)];
    await pi.settles();
    await spoolEmpty();
    // Resuming continues the same session file: the branch holds everything, and the new turns join it.
    const resumed = await piSession();
    resumed.session.branch = [...pi.session.branch, user("Back again", 20), assistant([text("Welcome back.")], 21)];
    await resumed.quits();
    await spoolEmpty();
    const doc = await until(() => archived(HEADER.id)?.includes("Welcome back.") && archived(HEADER.id));
    expect(turnsOf(doc)).toEqual([
      "Ada: Should the cutover wait for the audit?",
      "Pi: Yes: we decided to wait, because the audit closes Friday.",
      "Ada: Check the env file",
      "Pi: The file sets an API key; I left it alone.",
      "Ada: Ship it on Saturday",
      "Pi: Booked for Saturday.",
      "Ada: Back again",
      "Pi: Welcome back.",
    ]);
    for (const t of [doc, cacheOf(HEADER.id)]) for (const marker of [SECRET, TOOL_OUTPUT, MEMORY, SIDE, "attache-memory", "read-files"]) expect(t).not.toContain(marker);
  });

  it("the summary of the turns reads only the owner's and the assistant's words, never tool output, memory or a subagent's output", async () => {
    // Quitting the session summarises it straight away.
    const job = await until(() => jobsFor(HEADER.id).find((j) => j.status === "succeeded"), 20_000);
    expect(job.result).toMatchObject({ summarised: true });
    // An earlier boundary (the compaction) may already have summarised the session so far,
    // so wait for the summary that reads the whole session, the resumed turns included.
    const sent = await until(() => {
      const s = JSON.stringify(fx.requests.map((r) => r.body));
      return s.includes("Welcome back.") && s;
    }, 20_000);
    for (const marker of [SECRET, TOOL_OUTPUT, MEMORY, SIDE]) expect(sent).not.toContain(marker);
  });

  it("a cloned session is saved as its own conversation of only the turns after it left its parent", async () => {
    const pi = await piSession({ ...HEADER, id: "clone-1", parentSession: join(HOME, "missing-parent.jsonl") });
    pi.session.branch = [user("Cloned question", 1), assistant([text("Cloned answer.")], 2)];
    await pi.settles();
    await spoolEmpty();
    expect(turnsOf(await until(() => archived("clone-1")))).toEqual(["Ada: Cloned question", "Pi: Cloned answer."]);
  });

  it("after the owner moves to another branch with /tree, the turns already saved stay and the new branch's turns follow them", async () => {
    const pi = await piSession({ ...HEADER, id: "tree-1" });
    const root = user("Pick a database", 1);
    const a = [root, assistant([text("Postgres.")], 2), user("Why Postgres?", 3), assistant([text("Mature and boring.")], 4)];
    pi.session.branch = a;
    await pi.settles();
    await spoolEmpty();
    // The new branch starts again from the first question; the left branch is no longer on it.
    pi.session.branch = [root, assistant([text("SQLite.")], 5)];
    await pi.settles();
    await spoolEmpty();
    await until(() => archived("tree-1")?.includes("SQLite.") && archived("tree-1"));
    expect(turnsOf(archived("tree-1")!)).toEqual(["Ada: Pick a database", "Pi: Postgres.", "Ada: Why Postgres?", "Pi: Mature and boring.", "Pi: SQLite."]);
  });

  it("a snapshot in a Pi format Attache does not know saves nothing and reports that format on the Connection", async () => {
    spoolText(svc.stateDir, { agent: "pi", event: "turn-end", sessionId: "pi-new", cwd: HOME }, JSON.stringify({ attache: "pi-session", v: 1, header: { ...HEADER, id: "pi-new", version: 4 }, forkedAt: null, entries: [{ type: "message", id: "a", message: { role: "user", content: "secret plan" } }] }));
    await spoolEmpty();
    expect(archived("pi-new")).toBeNull();
    const w = await until(() => warnings().find((e) => e.data?.sessionId === "pi-new"));
    expect(w.data).toMatchObject({ agent: "pi", problem: expect.stringContaining("Pi session format version 4") });
    expect(readdirSync(join(svc.stateDir, "agents/unparsed")).some((f) => f.includes("pi-new"))).toBe(true);
    const c = (await svc.get<Array<{ kind: string; lastError?: string | null }>>("/connections")).find((x) => x.kind === "pi")!;
    expect(c.lastError).toMatch(/Pi session format version 4/);
  });
});

describe("the summariser's copy of a Pi session", () => {
  const cacheFile = (id: string) => join(svc.stateDir, "agents/sessions/pi", `${id}.json`);

  it("a copy that no longer parses is set aside once, and the session's next snapshot is still saved", async () => {
    const pi = await piSession({ ...HEADER, id: "corrupt-1" });
    const first = [user("Pick a region", 1), assistant([text("Frankfurt.")], 2)];
    pi.session.branch = first;
    await pi.settles();
    await spoolEmpty();
    writeFileSync(cacheFile("corrupt-1"), '{"turns": [');
    pi.session.branch = [...first, user("And the backup?", 3), assistant([text("Dublin.")], 4)];
    await pi.settles();
    await spoolEmpty();
    expect(turnsOf(await until(() => archived("corrupt-1")?.includes("Dublin.") && archived("corrupt-1")))).toEqual(["Ada: Pick a region", "Pi: Frankfurt.", "Ada: And the backup?", "Pi: Dublin."]);
    expect(warnings().filter((e) => e.data?.sessionId === "corrupt-1" && /summariser's copy/.test(e.msg))).toHaveLength(1);
    expect(JSON.parse(cacheOf("corrupt-1")).turns).toHaveLength(4);
  });

  it("is dropped once the session is summarised and no snapshot came for the retention period, and a later, longer snapshot is saved whole", async () => {
    const pi = await piSession({ ...HEADER, id: "quiet-1" });
    const first = [user("Pick a cache", 1), assistant([text("Redis.")], 2)];
    pi.session.branch = first;
    await pi.quits();
    await spoolEmpty();
    await until(() => jobsFor("quiet-1").find((j) => j.status === "succeeded"), 20_000);
    expect(existsSync(cacheFile("quiet-1"))).toBe(true);
    // The last snapshot came 31 days ago.
    svc.app.db.prepare("update agent_sessions set updated_at = ? where session_id = 'quiet-1'").run(new Date(Date.now() - 31 * 86_400_000).toISOString());
    svc.app.sessions.tick();
    expect(existsSync(cacheFile("quiet-1"))).toBe(false);
    const resumed = await piSession({ ...HEADER, id: "quiet-1" });
    resumed.session.branch = [...first, user("Still Redis?", 3), assistant([text("Yes.")], 4)];
    await resumed.settles();
    await spoolEmpty();
    expect(turnsOf(await until(() => archived("quiet-1")?.includes("Yes.") && archived("quiet-1")))).toEqual(["Ada: Pick a cache", "Pi: Redis.", "Ada: Still Redis?", "Pi: Yes."]);
  });

  it("after it was dropped, a snapshot shorter than what was saved never replaces the saved conversation", async () => {
    svc.app.db.prepare("update agent_sessions set updated_at = ? where session_id = 'quiet-1'").run(new Date(Date.now() - 31 * 86_400_000).toISOString());
    svc.app.db.prepare("update agent_sessions set distilled_turns = turns where session_id = 'quiet-1'").run();
    svc.app.sessions.tick();
    expect(existsSync(cacheFile("quiet-1"))).toBe(false);
    const resumed = await piSession({ ...HEADER, id: "quiet-1" });
    resumed.session.branch = [user("Only this", 5), assistant([text("Only that.")], 6)];
    await resumed.settles();
    await spoolEmpty();
    expect(turnsOf(archived("quiet-1")!)).toEqual(["Ada: Pick a cache", "Pi: Redis.", "Ada: Still Redis?", "Pi: Yes."]);
  });
});
