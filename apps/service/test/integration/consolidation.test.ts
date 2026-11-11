import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobView, ProposalView } from "@jarvis/contracts";
import { startTestService, type TestService } from "./harness.ts";
import { startMachines, type TestMachine, type TestWorld } from "./machines.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { installFixtureModel, type FixtureModel, type ModelCall } from "../fixtures/fixture-model.ts";
import { claudeTranscript } from "../fixtures/agents/transcripts.ts";
import { homeEnv, hookShell, runInShell } from "../fixtures/harness-shell.ts";

const HOME = process.env.JARVIS_AGENT_HOME!;
const ORION = "memory/projects/orion-migration.md";
const work = mkdtempSync(join(tmpdir(), "jarvis-it-consolidation-"));

let svc: TestService;
let fx: FixtureServer;
let model: FixtureModel;

/** A day `days` from now, written as the Brain dates facts. */
const dayFromNow = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function until<T>(fn: () => T | undefined | null | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** Run the SessionEnd command Jarvis registered in Claude Code's settings, the way Claude Code does. */
function runSessionEnd(service: TestService, sessionId: string, transcript: string) {
  const settings = JSON.parse(readFileSync(join(HOME, ".claude/settings.json"), "utf8"));
  const command = (settings.hooks.SessionEnd as Array<{ hooks: Array<{ command: string }> }>)
    .flatMap((g) => g.hooks)
    // On Windows the command names the state folder with forward slashes.
    .find((h) => h.command.includes("jarvis-agent-hook") && h.command.replace(/\\/g, "/").includes(service.stateDir.replace(/\\/g, "/")))!.command;
  runInShell(hookShell("claude-code"), command, { input: JSON.stringify({ session_id: sessionId, transcript_path: transcript, cwd: work, reason: "exit" }), env: { ...process.env, ...homeEnv(HOME) } });
}

const jobsOf = (service: TestService, kind: string, sessionId: string): JobView[] =>
  (service.app.db.prepare("select id from jobs where kind = ? and json_extract(input, '$.sessionId') = ? order by created_at").all(kind, sessionId) as Array<{ id: string }>).map((r) => service.app.jobs.get(r.id)!);

const finished = (j: JobView) => ["succeeded", "failed", "blocked", "cancelled"].includes(j.status);

/**
 * End a Claude Code session with these exchanges and wait until Jarvis has
 * summarised it and, when it found something durable, consolidated it.
 */
async function endSession(sessionId: string, exchanges: Array<[string, string]>, service: TestService = svc, opts: { awaitConsolidation?: boolean } = {}) {
  const seen = { distill: jobsOf(service, "session-distill", sessionId).length, consolidate: jobsOf(service, "session-consolidate", sessionId).length };
  const transcript = join(work, `${sessionId}.jsonl`);
  writeFileSync(transcript, claudeTranscript(sessionId, work, exchanges));
  runSessionEnd(service, sessionId, transcript);
  const distill = await until(() => jobsOf(service, "session-distill", sessionId).slice(seen.distill).find(finished));
  expect(distill.status).toBe("succeeded");
  const consolidations = () => jobsOf(service, "session-consolidate", sessionId).slice(seen.consolidate);
  const queued = (distill.result as { consolidation?: string } | null)?.consolidation === "queued";
  const consolidate = queued && opts.awaitConsolidation !== false ? await until(() => consolidations().find(finished)) : null;
  if (consolidate) expect(consolidate.status).toBe("succeeded");
  return { distill, consolidate, laterJobs: consolidations() };
}

/** Answer the next Consolidation calls with this reply, as a model would. */
function consolidationReplies(reply: (call: ModelCall) => unknown): () => void {
  return model.respond((call) => {
    if (!/Consolidation/.test(call.system)) return null;
    const answer = reply(call);
    return typeof answer === "string" ? answer : JSON.stringify(answer);
  });
}

async function proposalsFrom(sessionId: string, service: TestService = svc): Promise<ProposalView[]> {
  const { proposals } = await service.get<{ proposals: ProposalView[] }>("/memory/proposals?limit=500");
  return proposals.filter((p) => p.proposedBy === "Consolidation" && (p.source ?? "").includes(sessionId));
}

const note = (rel: string, service: TestService = svc) => readFileSync(join(service.dataDir, rel), "utf8");

async function connectModel(service: TestService) {
  await service.post("/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${fx.url}/model`, model: "fixture-model" } });
}

async function setUp(service: TestService) {
  await service.post("/setup/identity", { name: "Alex", email: "alex@example.com", confirm: true });
  await service.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned" }] }] });
}

beforeAll(async () => {
  mkdirSync(join(HOME, ".claude"), { recursive: true });
  fx = await startFixtureServer();
  model = installFixtureModel(fx);
  svc = await startTestService();
  await setUp(svc);
  await connectModel(svc);
  await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
});
afterAll(async () => {
  await svc?.stop();
  await fx?.close();
});

describe("Consolidation from a Harness session", () => {
  it("a finished session with a durable decision yields a Proposal naming the note, the value, the reason and the evidence, which waits for the owner", async () => {
    const review = dayFromNow(30);
    const quote = "We decided to move the Orion cutover to the first of December";
    const stop = consolidationReplies((call) => {
      // Consolidation reads the session and the notes search finds related to it.
      expect(call.user).toContain(quote);
      expect(call.user).toContain(ORION);
      expect(call.user).toContain("Cutover planned");
      return {
        proposals: [
          {
            item: { action: "update", path: ORION, facts: [{ subject: "Cutover date", value: "2026-12-01", review }], events: ["Cutover moved to 1 December"] },
            reason: "The session moved the cutover date.",
            evidence: quote,
          },
        ],
      };
    });
    try {
      const before = note(ORION);
      await endSession("s-decision", [["When do we cut Orion over?", `${quote}, because the vendor freeze ends then.`]]);
      const [p, ...rest] = await proposalsFrom("s-decision");
      expect(rest).toEqual([]);
      expect(p).toMatchObject({
        status: "proposed",
        target: ORION,
        reason: "The session moved the cutover date.",
        evidence: quote,
        item: { action: "update", path: ORION, facts: [{ subject: "Cutover date", value: "2026-12-01", review }], events: ["Cutover moved to 1 December"] },
      });
      // The evidence is cited in the session's archived transcript, down to the line.
      const cited = /\((agent-session): (evidence\/sessions\/transcripts\/claude-code\/[^#]+)#L(\d+)-L(\d+)/.exec(p!.source ?? "");
      expect(cited).not.toBeNull();
      expect(note(cited![2]!).split("\n")[Number(cited![3]) - 1]).toContain(quote);
      // Nothing is written until the owner applies it.
      expect(note(ORION)).toBe(before);
      await svc.post(`/memory/proposals/${p!.id}/apply`);
      expect(note(ORION)).toContain(`- **Cutover date** (${new Date().toISOString().slice(0, 10)}, review ${review}): 2026-12-01`);
    } finally {
      stop();
    }
  });

  it("a session with nothing durable yields no Proposal", async () => {
    const calls = model.calls.length;
    // The summary finds nothing durable, so Consolidation never runs.
    const quiet = await endSession("s-quiet", [["List the files.", "Here are the files in the folder."]]);
    expect(quiet.distill.result).toMatchObject({ durable: 0, consolidation: "nothing durable" });
    expect(quiet.laterJobs).toEqual([]);
    expect(model.calls.slice(calls).some((c) => /Consolidation/.test(c.system))).toBe(false);
    // The summary found a decision, but Consolidation finds nothing to change in the Brain.
    const stop = consolidationReplies(() => "NOTHING_DURABLE");
    try {
      const read = await endSession("s-nothing", [["Anything to change?", "We decided nothing needs to change today."]]);
      expect(read.consolidate?.result).toMatchObject({ proposals: 0 });
    } finally {
      stop();
    }
    expect(await proposalsFrom("s-quiet")).toEqual([]);
    expect(await proposalsFrom("s-nothing")).toEqual([]);
  });

  it("no session yields more than five Proposals, however often it is consolidated", async () => {
    const quote = "We decided to log the vendor freeze steps";
    const events = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ item: { action: "update", path: ORION, events: [`Vendor freeze step ${from + i} logged`] }, reason: "A step of the vendor freeze.", evidence: quote }));
    let stop = consolidationReplies(() => ({ proposals: events(1, 7) }));
    try {
      await endSession("s-many", [["Steps?", `${quote}, one by one.`]]);
    } finally {
      stop();
    }
    // The first five, in the model's order of importance.
    expect((await proposalsFrom("s-many")).flatMap((p) => p.item?.events ?? []).sort()).toEqual([1, 2, 3, 4, 5].map((n) => `Vendor freeze step ${n} logged`));
    // The session goes on and is consolidated again: it already has five.
    stop = consolidationReplies(() => ({ proposals: events(8, 3) }));
    try {
      const again = await endSession("s-many", [
        ["Steps?", `${quote}, one by one.`],
        ["More?", `${quote}, and we decided to add three more.`],
      ]);
      expect(again.consolidate?.result).toMatchObject({ proposals: 0 });
    } finally {
      stop();
    }
    expect(await proposalsFrom("s-many")).toHaveLength(5);
  });

  it("a Proposal that repeats a pending Proposal or an unchanged fact is not made", async () => {
    const quote = "We decided the Orion owner is Priya";
    const pending = await svc.post<ProposalView>("/memory/proposals", { item: { action: "update", path: ORION, facts: [{ subject: "Owner", value: "Priya", reason: "Named in planning." }] }, reason: "Named in planning." });
    const stop = consolidationReplies(() => ({
      proposals: [
        { item: { action: "update", path: ORION, facts: [{ subject: "Owner", value: "priya" }] }, reason: "The session named the owner.", evidence: quote },
        { item: { action: "update", path: ORION, facts: [{ subject: "Status", value: "Cutover planned" }] }, reason: "Still planned.", evidence: quote },
        { item: { action: "update", path: ORION, facts: [{ subject: "Status", value: "Cutover planned" }, { subject: "Sponsor", value: "Lars" }] }, reason: "The session named the sponsor.", evidence: quote },
      ],
    }));
    try {
      const r = await endSession("s-repeat", [["Who owns Orion?", `${quote}, and Lars sponsors it.`]]);
      expect(r.consolidate?.result).toMatchObject({ proposals: 1 });
    } finally {
      stop();
    }
    const made = await proposalsFrom("s-repeat");
    // Only what is new is left: the unchanged Status is removed from the third, the first two are dropped.
    expect(made.map((p) => p.item)).toEqual([{ action: "update", path: ORION, facts: [{ subject: "Sponsor", value: "Lars", reason: "The session named the sponsor." }] }]);
    await svc.post(`/memory/proposals/${pending.id}/reject`);
  });

  it("invalid model output is dropped, never applied, and what is valid still becomes a Proposal", async () => {
    const quote = "We decided to rename the Orion runbook";
    const before = note(ORION);
    const replies = [
      "Sure! Here is what I would change: rename the runbook.",
      JSON.stringify({
        proposals: [
          { item: { action: "update", path: "evidence/sessions/notes.md", events: ["Moved"] }, reason: "Outside memory.", evidence: quote },
          { item: { action: "update", path: "memory/self.md", facts: [{ subject: "Name", value: "Mallory" }] }, reason: "Identity.", evidence: quote },
          { item: { action: "update", path: "memory/projects/does-not-exist.md", events: ["Renamed"] }, reason: "Missing note.", evidence: quote },
          { item: { action: "update", path: ORION, facts: [{ subject: "Runbook", value: "orion-cutover.md", review: "2020-01-01" }] }, reason: "Past Review date.", evidence: quote },
          { item: { action: "update", path: ORION, events: ["Runbook renamed"] }, reason: "Invented evidence.", evidence: "We decided to delete every runbook" },
          { item: { action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Twin" }] }, reason: "Duplicate note.", evidence: quote },
          { item: { action: "delete", path: ORION }, reason: "Not an action.", evidence: quote },
          { item: { action: "update", path: ORION, events: ["Runbook renamed"] } },
          "not an object",
          { item: { action: "update", path: ORION, facts: [{ subject: "Runbook", value: "orion-cutover.md" }] }, reason: "The session renamed the runbook.", evidence: quote },
        ],
      }),
    ];
    const stop = consolidationReplies(() => replies.shift() ?? "NOTHING_DURABLE");
    try {
      // The first reply is prose: nothing comes of it.
      const prose = await endSession("s-invalid-prose", [["Rename it?", `${quote} soon.`]]);
      expect(prose.consolidate?.result).toMatchObject({ proposals: 0 });
      const r = await endSession("s-invalid", [["Rename it?", `${quote} to orion-cutover.md.`]]);
      expect(r.consolidate?.result).toMatchObject({ proposals: 1 });
      expect((r.consolidate?.result as { dropped: string[] }).dropped).toHaveLength(9);
    } finally {
      stop();
    }
    expect((await proposalsFrom("s-invalid")).map((p) => p.item)).toEqual([{ action: "update", path: ORION, facts: [{ subject: "Runbook", value: "orion-cutover.md", reason: "The session renamed the runbook." }] }]);
    expect(note(ORION)).toBe(before);
    expect(note("memory/self.md")).not.toContain("Mallory");
  });

  it("auto-accept never applies a Proposal from Consolidation", async () => {
    await svc.put("/harnesses/claude-code/auto-accept", { autoAccept: true });
    const quote = "We decided the Orion rollback window is two hours";
    const stop = consolidationReplies(() => ({ proposals: [{ item: { action: "update", path: ORION, facts: [{ subject: "Rollback window", value: "Two hours" }] }, reason: "Agreed in the session.", evidence: quote }] }));
    try {
      const before = note(ORION);
      await endSession("s-auto", [["Rollback?", `${quote}.`]]);
      expect((await proposalsFrom("s-auto")).map((p) => p.status)).toEqual(["proposed"]);
      expect(note(ORION)).toBe(before);
    } finally {
      stop();
      await svc.put("/harnesses/claude-code/auto-accept", { autoAccept: false });
    }
  });
});

describe("Corrections for contradicted facts", () => {
  const ATLAS = "memory/projects/atlas-launch.md";
  const today = () => new Date().toISOString().slice(0, 10);
  beforeAll(async () => {
    await svc.post("/memory/save", { confirmed: true, items: [{ action: "create", type: "project", title: "Atlas launch", facts: [{ subject: "Launch date", value: "1 March 2027" }, { subject: "Owner", value: "Priya" }, { subject: "Region", value: "EU only" }] }] });
  });

  it("a session that states a different value for a current fact yields a correction with the old value, the new value and the evidence, and approving it moves the old value to History with the reason", async () => {
    const quote = "The Atlas launch moves to 15 April 2027";
    const reason = "The session moved the Atlas launch from March to April.";
    const stop = consolidationReplies((call) => {
      // The model sees the fact the session contradicts, with its current value.
      expect(call.user).toContain(ATLAS);
      expect(call.user).toContain("Launch date: 1 March 2027");
      return { proposals: [{ item: { action: "update", path: ATLAS, facts: [{ subject: "Launch date", value: "15 April 2027" }] }, reason, evidence: quote }] };
    });
    try {
      await endSession("s-correct", [["When does Atlas launch?", `We decided it today: ${quote}, because the vendor slipped.`]]);
    } finally {
      stop();
    }
    const [p, ...rest] = await proposalsFrom("s-correct");
    expect(rest).toEqual([]);
    expect(p).toMatchObject({
      status: "proposed",
      target: ATLAS,
      reason,
      evidence: quote,
      corrections: [{ subject: "Launch date", was: { value: "1 March 2027", date: today(), review: null }, value: "15 April 2027" }],
    });
    await svc.post(`/memory/proposals/${p!.id}/apply`);
    const [current, history] = note(ATLAS).split("## History");
    expect(current).toContain(`- **Launch date** (${today()}): 15 April 2027`);
    expect(current).not.toContain("1 March 2027");
    expect(history).toContain(`**Launch date** was "1 March 2027" (dated ${today()}`);
    expect(history).toContain(`superseded: ${reason}`);
  });

  it("a correction whose old value changed before the owner decided is refused and stays pending, so it never replaces a value the owner was not shown", async () => {
    const quote = "Lars owns Atlas from now on";
    const stop = consolidationReplies(() => ({ proposals: [{ item: { action: "update", path: ATLAS, facts: [{ subject: "Owner", value: "Lars" }] }, reason: "The session handed Atlas to Lars.", evidence: quote }] }));
    try {
      await endSession("s-correct-stale", [["Who owns Atlas?", `We decided that ${quote}.`]]);
    } finally {
      stop();
    }
    const [p] = await proposalsFrom("s-correct-stale");
    expect(p!.corrections).toEqual([{ subject: "Owner", was: { value: "Priya", date: today(), review: null }, value: "Lars" }]);
    // The owner changes the fact from a Harness before deciding on the Proposal.
    await svc.post("/memory/save", { confirmed: true, items: [{ action: "update", path: ATLAS, facts: [{ subject: "Owner", value: "Mette", reason: "Priya moved team." }] }] });
    const before = note(ATLAS);
    const refused = await svc.call("POST", `/memory/proposals/${p!.id}/apply`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('it now says "Mette", not "Priya"');
    expect(note(ATLAS)).toBe(before);
    expect((await proposalsFrom("s-correct-stale")).map((q) => q.status)).toEqual(["proposed"]);
    expect((await svc.post<ProposalView>(`/memory/proposals/${p!.id}/reject`)).status).toBe("rejected");
  });

  it("a session that only repeats a current fact yields nothing, however the model writes the value back", async () => {
    const quote = "Atlas stays EU only, as before";
    const before = note(ATLAS);
    const stop = consolidationReplies(() => ({
      proposals: ["EU only.", '"EU only"', "**EU only**", "  eu   ONLY "].map((value) => ({ item: { action: "update", path: ATLAS, facts: [{ subject: "region", value }] }, reason: "The session confirmed the region.", evidence: quote })),
    }));
    try {
      const r = await endSession("s-repeat-fact", [["Where does Atlas run?", `We decided nothing new: ${quote}.`]]);
      expect(r.consolidate?.result).toMatchObject({ proposals: 0 });
    } finally {
      stop();
    }
    expect(await proposalsFrom("s-repeat-fact")).toEqual([]);
    expect(note(ATLAS)).toBe(before);
  });

  it("a fact that is mentioned but not contradicted yields nothing, while what the session did decide is still proposed", async () => {
    const quote = "Sofie leads the Atlas launch comms";
    const stop = consolidationReplies((call) => {
      // The model is told that a mention is not a contradiction.
      expect(call.system).toMatch(/mentions or repeats a current fact[^\n]*is not a correction/);
      return {
        proposals: [
          { item: { action: "update", path: ATLAS, facts: [{ subject: "Region", value: "EU only" }, { subject: "Comms lead", value: "Sofie" }] }, reason: "The session named the comms lead.", evidence: quote },
          { item: { action: "update", path: ATLAS, facts: [{ subject: "Region", value: "EU only." }] }, reason: "The session mentioned the region.", evidence: "the EU only launch" },
        ],
      };
    });
    try {
      const r = await endSession("s-mention", [["Who does comms?", `For the EU only launch, we decided ${quote}.`]]);
      expect(r.consolidate?.result).toMatchObject({ proposals: 1 });
    } finally {
      stop();
    }
    const made = await proposalsFrom("s-mention");
    expect(made.map((p) => ({ item: p.item, corrections: p.corrections }))).toEqual([
      { item: { action: "update", path: ATLAS, facts: [{ subject: "Comms lead", value: "Sofie", reason: "The session named the comms lead." }] }, corrections: [] },
    ]);
    await svc.post(`/memory/proposals/${made[0]!.id}/reject`);
  });
});

describe("Consolidation without a model", () => {
  let bare: TestService;
  beforeAll(async () => {
    bare = await startTestService();
    await setUp(bare);
    await bare.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
  });
  afterAll(async () => {
    await bare?.stop();
    // Give Claude Code back to the main service for any later test.
    await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
  });

  it("does nothing and says so", async () => {
    const before = note(ORION, bare);
    const r = await endSession("s-no-model", [["Cutover?", "We decided to cut Orion over on Friday."]], bare);
    expect(r.distill.result).toMatchObject({ summarised: false, consolidation: "no model" });
    expect(r.laterJobs).toEqual([]);
    expect(await proposalsFrom("s-no-model", bare)).toEqual([]);
    expect(note(ORION, bare)).toBe(before);
    const logs = readdirSync(join(bare.dataDir, "evidence/sessions")).filter((f) => f.endsWith(".md"));
    expect(note(`evidence/sessions/${logs[0]}`, bare)).toContain("No model is connected, so this session was saved without a summary, and Jarvis made no Proposals from it.");
  });

  it("a Consolidation that finds the model gone makes no Proposal and says why", async () => {
    // The session was summarised while a model was connected; the model is gone when Consolidation runs.
    await connectModel(bare);
    const stop = model.respond((call) => (/Consolidation/.test(call.system) ? JSON.stringify({ proposals: [{ item: { action: "update", path: ORION, events: ["Gone"] }, reason: "r", evidence: "We decided" }] }) : null));
    const create = bare.app.jobs.create.bind(bare.app.jobs);
    let queued: Parameters<typeof create>[0] | null = null;
    bare.app.jobs.create = ((input: Parameters<typeof create>[0]) => (input.kind === "session-consolidate" ? ((queued = input), { job: null, existing: true }) : create(input))) as typeof create;
    try {
      await endSession("s-model-gone", [["Cutover?", "We decided to cut Orion over on Monday."]], bare, { awaitConsolidation: false });
    } finally {
      bare.app.jobs.create = create;
      stop();
    }
    await bare.post("/connections/model/disconnect", { deleteData: false });
    const { job } = create(queued!);
    const { job: done } = await bare.waitJob(job.id, ["succeeded", "failed"]);
    expect(done.status).toBe("succeeded");
    expect(done.result).toMatchObject({ proposals: 0, skipped: "no model", message: "No model is connected, so Jarvis made no Proposals from this session." });
    expect(await proposalsFrom("s-model-gone", bare)).toEqual([]);
  });
});

describe("Consolidation with two Machines", () => {
  let world: TestWorld;
  afterAll(async () => {
    await world?.stop();
  });

  it("runs on the Machine where the session ended, and a Machine that receives the session through Replication does not consolidate it again", async () => {
    world = await startMachines(["Work Laptop", "Home PC"]);
    const [laptop, pc] = world.machines as [TestMachine, TestMachine];
    for (const m of [laptop, pc]) {
      await m.post("/setup/identity", { name: "Alex", email: "alex@example.com", confirm: true });
      await connectModel(m);
    }
    await laptop.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
    const quote = "We decided to hire Jonas as the Orion data engineer";
    const stop = consolidationReplies(() => ({
      proposals: [{ item: { action: "create", type: "person", title: "Jonas", facts: [{ subject: "Role", value: "Orion data engineer" }, { subject: "Starts", value: "January" }] }, reason: "Hired in the session.", evidence: quote }],
    }));
    try {
      await endSession("s-machine", [["Who joins?", `${quote}; he starts in January.`]], laptop);
    } finally {
      stop();
    }
    const [p] = await proposalsFrom("s-machine", laptop);
    expect(p).toMatchObject({ status: "proposed", target: "(new person: Jonas)", proposedOn: "Work Laptop", item: { action: "create", facts: [{ subject: "Role" }, { subject: "Starts" }] } });
    // The session's transcript, log and Proposal reach the Home PC, which does not consolidate the session again.
    await laptop.clock.advance(30_000);
    await pc.clock.advance(60_000);
    await until(() => readdirSync(join(pc.dataDir, "evidence/sessions")).some((f) => f.includes("work-laptop")));
    for (const kind of ["session-distill", "session-consolidate"]) expect(jobsOf(pc, kind, "s-machine")).toEqual([]);
    expect((await proposalsFrom("s-machine", pc)).map((q) => ({ id: q.id, proposedOn: q.proposedOn, evidence: q.evidence }))).toEqual([{ id: p!.id, proposedOn: "Work Laptop", evidence: quote }]);
  });
});
