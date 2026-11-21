import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { installFixtureModel } from "../fixtures/fixture-model.ts";
import { SECRET, TOOL_OUTPUT, v1Assistant, v1Normal, v1Text, v1User, v2Assistant, v2Compaction, v2Idle, v2ReadTool, v2User } from "../fixtures/agents/opencode.ts";
import { spoolDir, spoolText } from "../../src/agents/spool.ts";

/**
 * Saving OpenCode sessions through the real service: Attache's OpenCode plugin, loaded the way
 * OpenCode 1 and OpenCode 2 load it, spools snapshots at each turn's end and before each
 * compaction; the service joins them into one archived conversation of the owner's and the
 * assistant's words, and summarises that, never tool output or injected text.
 */

const HOME = process.env.ATTACHE_AGENT_HOME!;
const PLUGINS = join(HOME, ".config/opencode/plugins");
const WORK = join(HOME, "work", "orion");
const MEMORY = "<attache-memory>\nOrion migration is on track.\n</attache-memory>";

let svc: TestService;
let fx: FixtureServer;

const plugin = async () => {
  const [file] = readdirSync(PLUGINS).filter((f) => f.startsWith("attache"));
  return ((await import(`${join(PLUGINS, file!)}?v=${Math.random()}`)) as { default: { server: (i: unknown) => Promise<Record<string, (...a: unknown[]) => Promise<void>>>; setup: (ctx: unknown) => Promise<(() => Promise<void>) | void> } }).default;
};

/** OpenCode 2 hosting the plugin for one session whose context (messages since the last compaction) the test sets. */
async function openCode2(sessionID: string) {
  const session = { context: [] as unknown[] };
  const hooks: Record<string, (e: unknown) => Promise<void>> = {};
  await (await plugin()).setup({
    location: { directory: WORK },
    mcp: { transform: async () => ({ dispose: async () => {} }) },
    session: {
      hook: async (name: string, cb: (e: unknown) => Promise<void>) => ((hooks[name] = cb), { dispose: async () => {} }),
      get: async () => ({ id: sessionID, title: "Plan the Orion cutover", location: { directory: WORK } }),
      context: async () => session.context,
    },
  });
  return {
    session,
    turnEnds: () => hooks["experimental.idle"]!({ sessionID, background: [] }),
    compacts: (messages: unknown[]) => hooks.compaction!({ sessionID, messages }),
  };
}

/** OpenCode 1 hosting the plugin for one session whose full message list the test sets. */
async function openCode1(sessionID: string, messages: unknown[]) {
  const client = { session: { get: async () => ({ data: { id: sessionID, title: "Check the env", directory: WORK } }), messages: async () => ({ data: messages }) } };
  const hooks = await (await plugin()).server({ directory: WORK, client });
  return { turnEnds: () => hooks.event!({ event: { type: "session.status", properties: { sessionID, status: { type: "idle" } } } }) };
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
const archiveDir = () => join(svc.dataDir, "evidence/sessions/transcripts/opencode");
const archived = (sessionId: string) => {
  const f = existsSync(archiveDir()) ? readdirSync(archiveDir()).find((x) => x.includes(sessionId)) : undefined;
  return f ? readFileSync(join(archiveDir(), f), "utf8") : null;
};
/** The headings of an archived conversation's turns and their text, in order. */
const turnsOf = (doc: string) => [...doc.matchAll(/^### (\S+)[^\n]*\n\n([^\n]*)/gm)].map((m) => `${m[1]}: ${m[2]}`);
const cacheOf = (sessionId: string) => readFileSync(join(svc.stateDir, "agents/sessions/opencode", `${sessionId}.json`), "utf8");
const jobsFor = (sessionId: string) =>
  (svc.app.db.prepare("select id from jobs where kind = 'session-distill' and json_extract(input, '$.sessionId') = ?").all(sessionId) as Array<{ id: string }>).map((r) => svc.app.jobs.get(r.id)!);
const warnings = () =>
  readFileSync(join(svc.stateDir, "logs/service.log"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { level: string; msg: string; data?: Record<string, unknown> })
    .filter((e) => e.level === "warn");

beforeAll(async () => {
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.OPENCODE_CONFIG;
  process.env.ATTACHE_OPENCODE_BIN = join(HOME, "no-opencode-here");
  fx = await startFixtureServer();
  installFixtureModel(fx);
  svc = await startTestService({ stateDir: mkdtempSync(join(tmpdir(), "attache-it-opencode-capture-")) });
  await svc.post("/setup/identity", { name: "Ada", email: "ada@example.com", confirm: true });
  await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "On track" }] }] });
  await svc.post("/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${fx.url}/model`, model: "fixture-model" } });
  await svc.post("/connections/opencode/configure", { method: "hooks", fields: {} });
  // The plugin spools only while the service keeps the session context, which it writes once it has started.
  await until(() => existsSync(join(svc.stateDir, "agents/session-context.md")));
});
afterAll(async () => {
  await svc?.stop();
  await fx?.close();
  delete process.env.ATTACHE_OPENCODE_BIN;
});

describe("OpenCode session capture", () => {
  it("is offered as capture at each turn, with no session end, and the Connection says the newest in-flight turn can be missed", async () => {
    const def = (await svc.get<{ definitions: Array<{ kind: string; description?: string; setupHelp?: string; harness?: { capabilities: { capture: string } } }> }>("/capabilities")).definitions.find((d) => d.kind === "opencode")!;
    expect(def.harness!.capabilities.capture).toBe("without-final-event");
    expect(def.description).toMatch(/save your OpenCode sessions/);
    expect(def.setupHelp).toMatch(/newest turn/);
  });

  it("OpenCode 2: turns before and after a compaction are saved as one conversation, without tool output, memory or the summary", async () => {
    const oc = await openCode2("ses_v2");
    const first = [v2User(`${MEMORY}\nShould the cutover wait for the audit?`, 0), v2Assistant([{ type: "text", text: "Yes: we decided to wait for the Friday audit." }], 1), v2Idle(2)];
    oc.session.context = first;
    await oc.turnEnds();
    await spoolEmpty();
    const second = [v2User("Check the env file", 3), v2Assistant([v2ReadTool()], 4), v2Assistant([{ type: "text", text: "It sets an API key; I left it alone." }], 5)];
    // The compaction hook gets the messages being summarised, in the model's request shape.
    await oc.compacts([...first, ...second].filter((m) => m.type !== "idle").map((m) => ({ id: m.id, role: m.type, content: m.type === "user" ? [{ type: "text", text: (m as { text: string }).text }] : (m as { content: unknown[] }).content.map((c) => (c as { type: string }).type === "tool" ? { type: "tool-call", name: "read" } : c) })));
    // After the compaction OpenCode 2's context starts at the compaction: the earlier turns are gone from it.
    oc.session.context = [v2Compaction(6, "## Objective\n- the summary text"), v2Idle(7), v2User("Ship it on Saturday", 8), v2Assistant([{ type: "text", text: "Booked for Saturday." }], 9)];
    await oc.turnEnds();
    await spoolEmpty();
    const doc = await until(() => archived("ses_v2")?.includes("Booked for Saturday") && archived("ses_v2"));
    expect(turnsOf(doc)).toEqual([
      "Ada: Should the cutover wait for the audit?",
      "OpenCode: Yes: we decided to wait for the Friday audit.",
      "Ada: Check the env file",
      "OpenCode: It sets an API key; I left it alone.",
      "Ada: Ship it on Saturday",
      "OpenCode: Booked for Saturday.",
    ]);
    for (const text of [doc, cacheOf("ses_v2")]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(TOOL_OUTPUT);
      expect(text).not.toContain("attache-memory");
      expect(text).not.toContain("the summary text");
    }
  });

  it("the summary of the turns reads only the owner's and the assistant's words, never tool output or injected memory", async () => {
    // A turn's end waits for the conversation to be quiet for a while before summarising; the test does not wait that long.
    const queued = jobsFor("ses_v2").find((j) => j.status === "queued");
    svc.app.jobs.reschedule(queued!.id, null);
    const job = await until(() => jobsFor("ses_v2").find((j) => j.status === "succeeded"), 20_000);
    expect(job.result).toMatchObject({ summarised: true });
    const sent = JSON.stringify(fx.requests.map((r) => r.body));
    expect(sent).toContain("Booked for Saturday.");
    expect(sent).not.toContain(SECRET);
    expect(sent).not.toContain(TOOL_OUTPUT);
    expect(sent).not.toContain("Orion migration is on track");
  });

  it("OpenCode 1: the whole session is saved at each turn's end, and a later turn only adds to it", async () => {
    const messages: unknown[] = v1Normal();
    const oc = await openCode1("ses_v1", messages);
    await oc.turnEnds();
    await spoolEmpty();
    messages.push(v1User("", 10, [{ type: "compaction", auto: true, overflow: true }]), v1Assistant([v1Text("## Objective\n- v1 summary")], 11, { summary: true }), v1User("Check the env file", 12), v1Assistant([v1Text("All done.")], 13));
    await oc.turnEnds();
    await spoolEmpty();
    const doc = await until(() => archived("ses_v1")?.includes("All done.") && archived("ses_v1"));
    expect(turnsOf(doc)).toEqual([
      "Ada: Should the cutover wait for the audit?",
      "OpenCode: Yes: we decided to wait, because the audit closes Friday.",
      "Ada: Check the env file",
      "OpenCode: The file sets an API key; I left it alone.",
      "OpenCode: All done.",
    ]);
    expect(doc).not.toContain(SECRET);
    expect(doc).not.toContain(TOOL_OUTPUT);
    expect(doc).not.toContain("v1 summary");
  });

  it("a snapshot in an OpenCode format Attache does not know saves nothing and reports that format on the Connection", async () => {
    spoolText(svc.stateDir, { agent: "opencode", event: "turn-end", sessionId: "ses_new", cwd: WORK }, JSON.stringify({ attache: "opencode-session", v: 1, opencode: 3, shape: "v3-stream", sessionID: "ses_new", parentID: null, title: null, directory: WORK, messages: [{ kind: "said", text: "secret plan" }] }));
    await spoolEmpty();
    expect(archived("ses_new")).toBeNull();
    const w = await until(() => warnings().find((e) => e.data?.sessionId === "ses_new"));
    expect(w.data).toMatchObject({ agent: "opencode", problem: expect.stringContaining('"OpenCode 3 v3-stream"') });
    expect(readdirSync(join(svc.stateDir, "agents/unparsed")).some((f) => f.includes("ses_new"))).toBe(true);
    const c = (await svc.get<Array<{ kind: string; lastError?: string | null }>>("/connections")).find((x) => x.kind === "opencode")!;
    expect(c.lastError).toMatch(/OpenCode 3 v3-stream/);
  });
});
