import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { installFixtureModel } from "../fixtures/fixture-model.ts";
import { MEMORY, SECRET, SESSION, SIDE, TOOL_OUTPUT, assistant, compaction, event, events, hook, memoryHook, normal, readTool, resume, shutdown, start, subagent, turn, turnEnd, user, type CopilotEvent } from "../fixtures/agents/copilot-cli.ts";
import { harnessCaptureGrant } from "../../src/agents/harness-session-state.ts";
import { spoolCapture, spoolDir } from "../../src/agents/spool.ts";

/**
 * Saving Copilot CLI sessions through the real service: the hooks Attache installs in Copilot CLI's
 * personal hooks file, run the way Copilot CLI runs them (their bash command, the hook's input on
 * stdin, Copilot CLI's home folder), copy the session's events.jsonl after each turn, before a
 * compaction and when the session ends; the service archives one conversation of the owner's and
 * the assistant's words per session and summarises that, never tool output, injected memory or a
 * subagent's output.
 */

const HOME = process.env.ATTACHE_AGENT_HOME!;
const COPILOT = join(HOME, ".copilot");
const eventsFile = (id: string) => join(COPILOT, "session-state", id, "events.jsonl");

let svc: TestService;
let fx: FixtureServer;
let hooksFile: string;

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
const archiveDir = () => join(svc.dataDir, "evidence/sessions/transcripts/copilot-cli");
const archived = (sessionId: string) => {
  const f = existsSync(archiveDir()) ? readdirSync(archiveDir()).find((x) => x.includes(sessionId)) : undefined;
  return f ? readFileSync(join(archiveDir(), f), "utf8") : null;
};
/** The headings of an archived conversation's turns and their text, in order. */
const turnsOf = (doc: string) => [...doc.matchAll(/^### (\S+(?: CLI)?)[^\n]*\n\n([^\n]*)/gm)].map((m) => `${m[1]}: ${m[2]}`);
const cacheOf = (sessionId: string) => readFileSync(join(svc.stateDir, "agents/sessions/copilot-cli", `${sessionId}.json`), "utf8");
const jobsFor = (sessionId: string) =>
  (svc.app.db.prepare("select id from jobs where kind = 'session-distill' and json_extract(input, '$.sessionId') = ?").all(sessionId) as Array<{ id: string }>).map((r) => svc.app.jobs.get(r.id)!);
const warnings = () =>
  readFileSync(join(svc.stateDir, "logs/service.log"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { level: string; msg: string; data?: Record<string, unknown> })
    .filter((e) => e.level === "warn");

let clock = 1795294232000;
/**
 * Copilot CLI ending a turn, compacting or ending the session: it starts Attache's hook for that
 * event with the hook's input, then appends the session's latest events and the hook's own
 * hook.start to events.jsonl while the hook runs.
 */
async function copilotRuns(hookType: "agentStop" | "preCompact" | "sessionEnd", id: string, written: CopilotEvent[], extra: Record<string, unknown> = {}) {
  const input = { sessionId: id, timestamp: clock++, cwd: HOME, ...(hookType === "sessionEnd" ? { reason: "user_exit" } : { transcriptPath: eventsFile(id) }), ...extra };
  const command = (JSON.parse(readFileSync(hooksFile, "utf8")) as { hooks: Record<string, Array<{ bash: string }>> }).hooks[hookType]![0]!.bash;
  const child = spawn("bash", ["-c", command], { env: { ...process.env, HOME, USERPROFILE: HOME } });
  let stdout = "";
  child.stdout.on("data", (d) => (stdout += String(d)));
  const closed = new Promise<number | null>((r) => child.on("close", r));
  child.stdin.end(JSON.stringify(input));
  await new Promise((r) => setTimeout(r, 100));
  const file = (extra.transcriptPath as string | undefined) ?? eventsFile(id);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, events([...written, event("hook.start", 0, { hookInvocationId: "x", hookType, input })]));
  expect(await closed).toBe(0);
  expect(stdout).toBe("");
}

beforeAll(async () => {
  delete process.env.COPILOT_HOME;
  process.env.ATTACHE_COPILOT_BIN = join(HOME, "no-copilot-here");
  fx = await startFixtureServer();
  installFixtureModel(fx);
  svc = await startTestService({ stateDir: mkdtempSync(join(tmpdir(), "attache-it-copilot-capture-")) });
  await svc.post("/setup/identity", { name: "Ada", email: "ada@example.com", confirm: true });
  await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "On track" }] }] });
  await svc.post("/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${fx.url}/model`, model: "fixture-model" } });
  await svc.post("/connections/copilot-cli/configure", { method: "hooks", fields: {} });
  hooksFile = readdirSync(join(COPILOT, "hooks"))
    .filter((f) => f.startsWith("attache"))
    .map((f) => join(COPILOT, "hooks", f))[0]!;
  await until(() => existsSync(join(svc.stateDir, "agents/session-context.md")));
});
afterAll(async () => {
  delete process.env.ATTACHE_COPILOT_BIN;
  await svc?.stop();
  await fx?.close();
});

describe("Copilot CLI session capture", () => {
  it("is offered as capture with a final event, and the Connection says only a Copilot CLI killed mid-turn can lose its newest turn", async () => {
    const def = (await svc.get<{ definitions: Array<{ kind: string; description?: string; setupHelp?: string; harness?: { capabilities: { capture: string } } }> }>("/capabilities")).definitions.find((d) => d.kind === "copilot-cli")!;
    expect(def.harness!.capabilities.capture).toBe("with-final-event");
    expect(def.description).toMatch(/save your Copilot CLI sessions/);
    expect(def.setupHelp).toMatch(/killed or crashes mid-turn can lose that newest turn/);
  });

  it("turns, a compaction, a subagent and a resume are saved as one conversation, each turn once, without tool output, memory, side-chains or the summary", async () => {
    const all = normal();
    const firstTurn = all.findIndex((e) => e.type === "hook.start" && e.data.hookType === "agentStop");
    await copilotRuns("agentStop", SESSION, all.slice(0, firstTurn));
    await spoolEmpty();
    await copilotRuns("agentStop", SESSION, all.slice(firstTurn));
    await spoolEmpty();
    await copilotRuns("preCompact", SESSION, [event("session.compaction_start", 6, { compactionAttemptId: "c1" })]);
    await spoolEmpty();
    // A subagent's own agentStop names the parent's file; the parent's hooks save the session.
    await copilotRuns("agentStop", "3879bcc5-1220-473e-beb5-cdae729e1f0f", [...compaction(6).slice(-1), user("Ship it on Saturday", 7), ...turn(7), ...subagent(7)], { agentId: "3879bcc5-1220-473e-beb5-cdae729e1f0f", parentAgentId: SESSION, transcriptPath: eventsFile(SESSION) });
    await copilotRuns("agentStop", SESSION, [...turn(8, "1"), assistant("Booked for Saturday.", 8), turnEnd(8, "1")]);
    await spoolEmpty();
    await copilotRuns("sessionEnd", SESSION, []);
    await spoolEmpty();
    appendFileSync(eventsFile(SESSION), events([shutdown(9)]));
    // Resuming appends to the same file: the copy holds everything, and the new turns follow.
    await copilotRuns("agentStop", SESSION, [resume(20), memoryHook(20)[0]!, user("Back again", 21), memoryHook(21)[1]!, ...turn(22), ...readTool(22), assistant("Welcome back.", 23), turnEnd(23)]);
    await copilotRuns("sessionEnd", SESSION, []);
    await spoolEmpty();
    const doc = await until(() => archived(SESSION)?.includes("Welcome back.") && archived(SESSION));
    expect(turnsOf(doc)).toEqual([
      "Ada: Should the cutover wait for the audit?",
      "Copilot CLI: Yes: we decided to wait, because the audit closes Friday.",
      "Ada: Check the env file",
      "Copilot CLI: The file sets an API key; I left it alone.",
      "Ada: Ship it on Saturday",
      "Copilot CLI: Booked for Saturday.",
      "Ada: Back again",
      "Copilot CLI: Welcome back.",
    ]);
    expect(readdirSync(archiveDir()).filter((f) => f.includes("3879bcc5"))).toEqual([]);
    for (const t of [doc, cacheOf(SESSION)]) for (const marker of [SECRET, TOOL_OUTPUT, MEMORY, SIDE, "attache-memory", "overview"]) expect(t).not.toContain(marker);
  });

  it("the summary reads only the owner's and the assistant's words, and the session log holds each turn once", async () => {
    const job = await until(() => jobsFor(SESSION).find((j) => j.status === "succeeded"), 20_000);
    expect(job.result).toMatchObject({ summarised: true });
    // An earlier boundary (the compaction) may already have summarised the session so far,
    // so wait until the whole session, the resumed turns included, has been summarised.
    const sent = await until(() => {
      const s = JSON.stringify(fx.requests.map((r) => r.body));
      return s.includes("Welcome back.") && s;
    }, 20_000);
    for (const marker of [SECRET, TOOL_OUTPUT, MEMORY, SIDE]) expect(sent).not.toContain(marker);
    // Each turn reached the summariser once across every summary: later copies of the file never resend saved turns.
    await until(() => (svc.app.db.prepare("select distilled_turns from agent_sessions where agent = 'copilot-cli' and session_id = ?").get(SESSION) as { distilled_turns: number }).distilled_turns === 8, 20_000);
    const summaries = JSON.stringify(fx.requests.map((r) => r.body).filter((b) => JSON.stringify(b).includes("You summarise a finished Harness session")));
    expect(summaries.split("Ada: Should the cutover wait for the audit?").length - 1).toBe(1);
    expect(summaries.split("Copilot CLI: Welcome back.").length - 1).toBe(1);
  });

  it("a file in a Copilot CLI format Attache does not know saves nothing and reports that format on the Connection", async () => {
    const id = "7d3e2fbd-2ae8-46e1-9451-dab9dff6950a";
    mkdirSync(dirname(eventsFile(id)), { recursive: true });
    writeFileSync(eventsFile(id), events([start(0, 2), user("secret plan", 1), assistant("ok", 2)]));
    spoolCapture(svc.stateDir, { agent: "copilot-cli", event: "session-end", sessionId: id, cwd: HOME, sourcePath: eventsFile(id) });
    await spoolEmpty();
    expect(archived(id)).toBeNull();
    const w = await until(() => warnings().find((e) => e.data?.sessionId === id));
    expect(w.data).toMatchObject({ agent: "copilot-cli", problem: expect.stringContaining("Copilot CLI events format version 2") });
    expect(readdirSync(join(svc.stateDir, "agents/unparsed")).some((f) => f.includes(id))).toBe(true);
    const c = (await svc.get<Array<{ kind: string; lastError?: string | null }>>("/connections")).find((x) => x.kind === "copilot-cli")!;
    expect(c.lastError).toMatch(/Copilot CLI events format version 2/);
  });

  it("a session that ends before anything was said saves nothing and warns of nothing", async () => {
    const id = "0e9a91ab-b0bc-4834-a435-73a7cd142907";
    await copilotRuns("sessionEnd", id, [start(0), ...hook("sessionStart", 0)]);
    await spoolEmpty();
    expect(archived(id)).toBeNull();
    expect(warnings().some((e) => e.data?.sessionId === id)).toBe(false);
  });

  it("keeps an authorised boundary answer and excludes all tool follow-ups of a paused interaction", async () => {
    const id = "resume-across-capture-pause";
    const sourcePath = eventsFile(id);
    mkdirSync(dirname(sourcePath), { recursive: true });
    const cutoff = Date.now();
    const at = (e: CopilotEvent, offset: number) => ({ ...e, timestamp: new Date(cutoff + offset).toISOString() });
    const before = [
      at(start(), -20),
      at(user("Finish this before disconnect", 0), -10),
      ...turn(0, "1", "first").map((e) => at(e, -9)),
      at(assistant("Authorised at the cutoff", 0, { interactionId: "first" }), 0),
      at(turnEnd(0, "1"), 0),
      at(user("Start a second response", 0, { delivery: "steering" }), -1),
    ];
    const input = { agent: "copilot-cli", event: "turn-end", sessionId: id, cwd: HOME, sourcePath } as const;
    vi.setSystemTime(cutoff);
    try {
      writeFileSync(sourcePath, events(before));
      const captureGrant = harnessCaptureGrant(svc.stateDir, "copilot-cli")!;
      expect(captureGrant).toBeTruthy();
      spoolCapture(svc.stateDir, { ...input, captureGrant });
      await svc.post("/connections/copilot-cli/disconnect", { deleteData: false });
      expect(svc.app.sessions.ingest().ingested).toBe(1);
      expect(archived(id)).toContain("Authorised at the cutoff");

      vi.setSystemTime(cutoff + 10);
      await svc.post("/connections/copilot-cli/configure", { method: "hooks", fields: {} });
      vi.setSystemTime(cutoff + 20);
      appendFileSync(sourcePath, events([
        ...turn(0, "2", "crossed").map((e) => at(e, 5)),
        at(assistant("Streamed while paused: private tool marker", 0, { interactionId: "crossed" }), 12),
        at(turnEnd(0, "2"), 13),
        ...turn(0, "3", "crossed").map((e) => at(e, 14)),
        at(assistant("Tool follow-up repeats the private tool marker", 0, { interactionId: "crossed" }), 15),
        at(turnEnd(0, "3"), 16),
        at(user("A fresh question", 0), 17),
        ...turn(0, "4", "fresh").map((e) => at(e, 18)),
        at(assistant("A fresh answer", 0, { interactionId: "fresh" }), 19),
        at(turnEnd(0, "4"), 20),
      ]));
      spoolCapture(svc.stateDir, { ...input, captureGrant: harnessCaptureGrant(svc.stateDir, "copilot-cli")! });
      expect(svc.app.sessions.ingest().ingested).toBe(1);
      expect(turnsOf(archived(id)!)).toEqual([
        "Ada: Finish this before disconnect",
        "Copilot CLI: Authorised at the cutoff",
        "Ada: Start a second response",
        "Ada: A fresh question",
        "Copilot CLI: A fresh answer",
      ]);
      expect(cacheOf(id)).not.toContain("private tool marker");
    } finally {
      vi.useRealTimers();
      await svc.post("/connections/copilot-cli/configure", { method: "hooks", fields: {} });
    }
  });
});
