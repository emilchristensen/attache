import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { JobView, ProposalView } from "@jarvis/contracts";
import { startTestService, type TestService } from "./harness.ts";
import { startMachines, type TestMachine, type TestWorld } from "./machines.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { installFixtureModel, type FixtureModel, type ModelCall } from "../fixtures/fixture-model.ts";

const ORION = "memory/projects/orion-migration.md";
const JOB = "capture-consolidate";

let svc: TestService;
let fx: FixtureServer;
let model: FixtureModel;

async function until<T>(fn: () => T | undefined | null | false | Promise<T | undefined | null | false>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * A meeting capture as the owner's meeting export writes it into the Brain:
 * frontmatter tagged as a meeting, then the meeting's notes and transcript quoted.
 */
function meetingCapture(title: string, lines: readonly string[], tags: readonly string[] = ["granola", "meeting-transcript"]): string {
  return [
    "---",
    "id: 3f1c2a4e-0000-4000-8000-000000000001",
    "type: capture",
    `title: "${title}"`,
    "captured_at: 2026-11-11T08:29:38.048Z",
    "provenance: captured",
    "source:",
    "  kind: import",
    "  ref: https://notes.example.com/d/standup",
    "  observed_at: 2026-11-11T08:29:38.048Z",
    "  label: Meeting export",
    "tags:",
    ...tags.map((t) => `  - ${t}`),
    "---",
    `# ${title}`,
    "",
    ...lines.map((l) => (l ? `> ${l}` : ">")),
    "",
    "Source: Meeting export (import: https://notes.example.com/d/standup, observed 2026-11-11)",
    "",
  ].join("\n");
}

/** Put a file into a Machine's copy of the Brain from outside Jarvis, as an export routine or an editor does. */
function writeIntoBrain(service: TestService, rel: string, content: string) {
  mkdirSync(dirname(join(service.dataDir, rel)), { recursive: true });
  writeFileSync(join(service.dataDir, rel), content);
}

async function jobs(service: TestService): Promise<JobView[]> {
  return ((await service.get<JobView[]>("/jobs?limit=500")) as JobView[]).filter((j) => j.kind === JOB);
}

const finished = (j: JobView) => ["succeeded", "failed", "blocked", "cancelled"].includes(j.status);

/** Wait until Jarvis has consolidated the capture at `rel`, and return that job. */
async function consolidated(service: TestService, rel: string): Promise<JobView> {
  const job = await until(async () => (await jobs(service)).find((j) => finished(j) && (j.result as { capture?: string } | null)?.capture === rel));
  expect(job.status).toBe("succeeded");
  return job;
}

/** The captures Consolidation was started for since `before` was taken, finished or not. */
async function startedSince(service: TestService, before: ReadonlySet<string>): Promise<Array<string | null>> {
  return (await jobs(service)).filter((j) => !before.has(j.id)).map((j) => (j.result as { capture?: string } | null)?.capture ?? null);
}

const jobIds = async (service: TestService) => new Set((await jobs(service)).map((j) => j.id));

/** Answer the next Consolidation calls with this reply, as a model would. */
function consolidationReplies(reply: (call: ModelCall) => unknown): () => void {
  return model.respond((call) => {
    if (!/Consolidation/.test(call.system)) return null;
    const answer = reply(call);
    return typeof answer === "string" ? answer : JSON.stringify(answer);
  });
}

async function proposalsFrom(rel: string, service: TestService = svc): Promise<ProposalView[]> {
  const { proposals } = await service.get<{ proposals: ProposalView[] }>("/memory/proposals?limit=500");
  return proposals.filter((p) => p.proposedBy === "Consolidation" && (p.source ?? "").includes(rel));
}

const read = (rel: string, service: TestService = svc) => readFileSync(join(service.dataDir, rel), "utf8");
const consolidationCalls = () => model.calls.filter((c) => /Consolidation/.test(c.system)).length;

async function connectModel(service: TestService) {
  await service.post("/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${fx.url}/model`, model: "fixture-model" } });
}

async function setUp(service: TestService) {
  await service.post("/setup/identity", { name: "Alex", email: "alex@example.com", confirm: true });
  await service.post("/memory/save", { items: [{ action: "create", type: "project", title: "Orion migration", facts: [{ subject: "Status", value: "Cutover planned" }] }] });
}

beforeAll(async () => {
  fx = await startFixtureServer();
  model = installFixtureModel(fx);
  svc = await startTestService();
  await setUp(svc);
  await connectModel(svc);
});
afterAll(async () => {
  await svc?.stop();
  await fx?.close();
});

describe("Consolidation from a meeting capture", () => {
  const STANDUP = "evidence/captures/2026-11-11-granola-orion-stand-up.md";

  it("a new meeting capture yields Proposals that cite the capture and the lines they rest on, and wait for the owner", async () => {
    const stop = consolidationReplies((call) => {
      // Consolidation reads the meeting, not a Harness session, with the notes search finds related to it.
      expect(call.system).toMatch(/meeting/);
      expect(call.user).toContain("Priya confirmed the vendor freeze ends on 30 November");
      expect(call.user).toContain(ORION);
      expect(call.user).toContain("Cutover planned");
      return {
        proposals: [
          {
            item: { action: "update", path: ORION, facts: [{ subject: "Cutover date", value: "2026-12-01" }], events: ["Stand-up moved the cutover to 1 December"] },
            reason: "The stand-up moved the cutover.",
            // Quoted across two lines of the transcript.
            evidence: "we move the Orion cutover to the first of December, after the vendor freeze",
          },
          {
            item: { action: "update", path: ORION, facts: [{ subject: "Vendor freeze ends", value: "2026-11-30" }] },
            reason: "Priya confirmed the end of the freeze.",
            evidence: "Priya confirmed the vendor freeze ends on 30 November",
          },
        ],
      };
    });
    const before = read(ORION);
    try {
      writeIntoBrain(
        svc,
        STANDUP,
        meetingCapture("Granola 2026-11-11: Orion stand-up", [
          "# Orion stand-up",
          "",
          "- Participants: Alex, Priya",
          "",
          "## Transcript",
          "",
          "[0:01] Alex: Morning. Where are we with the cutover?",
          "[0:12] Priya: Priya confirmed the vendor freeze ends on 30 November.",
          "[0:30] Alex: Then we move the Orion cutover to the first of December,",
          "after the vendor freeze, and we tell the client today.",
        ]),
      );
      const job = await consolidated(svc, STANDUP);
      expect(job.result).toMatchObject({ capture: STANDUP, proposals: 2 });
    } finally {
      stop();
    }
    const made = await proposalsFrom(STANDUP);
    expect(made.map((p) => p.reason).sort()).toEqual(["Priya confirmed the end of the freeze.", "The stand-up moved the cutover."]);
    const lines = read(STANDUP).split("\n");
    for (const p of made) {
      expect(p).toMatchObject({ status: "proposed", target: ORION });
      // The capture is cited down to the lines that hold the quoted evidence.
      const cited = /\(capture: ([^#]+)#L(\d+)-L(\d+)/.exec(p.source ?? "");
      expect(cited).not.toBeNull();
      expect(cited![1]).toBe(STANDUP);
      const quoted = lines.slice(Number(cited![2]) - 1, Number(cited![3])).join(" ");
      for (const word of p.evidence!.split(" ")) expect(quoted).toContain(word);
    }
    const cutover = made.find((p) => p.reason === "The stand-up moved the cutover.")!;
    expect(cutover.source).toMatch(/#L(\d+)-L(\d+)/);
    const [, from, to] = /#L(\d+)-L(\d+)/.exec(cutover.source!)!;
    expect(Number(to) - Number(from)).toBe(1);
    // Nothing is written until the owner applies a Proposal.
    expect(read(ORION)).toBe(before);
  });

  it("what Consolidation drops from a meeting is reported as the meeting's, never a session's", async () => {
    const rel = "evidence/captures/2026-11-11-granola-orion-retro.md";
    const stop = consolidationReplies(() => ({
      proposals: [{ item: { action: "update", path: ORION, facts: [{ subject: "Retro owner", value: "Priya" }] }, reason: "Made up.", evidence: "words nobody said in the retro" }],
    }));
    try {
      writeIntoBrain(svc, rel, meetingCapture("Granola 2026-11-11: Orion retro", ["[0:01] Alex: Short retro today."]));
      const job = await consolidated(svc, rel);
      expect(job.result).toMatchObject({ capture: rel, proposals: 0, dropped: ["its evidence is not quoted from the meeting"] });
    } finally {
      stop();
    }
  });

  it("a meeting capture that states a different value for a current fact yields a correction, as a session does", async () => {
    const rel = "evidence/captures/2026-11-11-granola-orion-steering.md";
    const today = new Date().toISOString().slice(0, 10);
    const quote = "Orion is on hold until the vendor contract is signed";
    const reason = "The steering group put Orion on hold.";
    const stop = consolidationReplies((call) => {
      // The model reads the meeting with the same correction rules a session gets, and sees the fact the meeting contradicts.
      expect(call.system).toMatch(/A correction: when the meeting states a different value/);
      expect(call.system).toMatch(/A meeting that mentions or repeats a current fact[^\n]*is not a correction/);
      expect(call.user).toContain(`Status: Cutover planned (since ${today})`);
      return { proposals: [{ item: { action: "update", path: ORION, facts: [{ subject: "Status", value: "On hold" }] }, reason, evidence: quote }] };
    });
    try {
      writeIntoBrain(svc, rel, meetingCapture("Granola 2026-11-11: Orion steering", ["## Transcript", "", `[0:20] Priya: We decided that ${quote}.`]));
      await consolidated(svc, rel);
    } finally {
      stop();
    }
    const [p, ...rest] = await proposalsFrom(rel);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({
      status: "proposed",
      target: ORION,
      reason,
      evidence: quote,
      corrections: [{ subject: "Status", was: { value: "Cutover planned", date: today, review: null }, value: "On hold" }],
    });
    await svc.post(`/memory/proposals/${p!.id}/apply`);
    const [current, history] = read(ORION).split("## History");
    expect(current).toContain(`- **Status** (${today}): On hold`);
    expect(history).toContain(`**Status** was "Cutover planned" (dated ${today}`);
    expect(history).toContain(`superseded: ${reason}`);
  });

  it("a meeting capture yields at most five Proposals", async () => {
    const rel = "evidence/captures/2026-11-11-granola-orion-planning.md";
    const quote = "We agreed to log every step of the vendor freeze";
    const steps = Array.from({ length: 7 }, (_, i) => ({ item: { action: "update", path: ORION, events: [`Freeze step ${i + 1} logged`] }, reason: "A step of the freeze.", evidence: quote }));
    const stop = consolidationReplies(() => ({ proposals: steps }));
    try {
      writeIntoBrain(svc, rel, meetingCapture("Granola 2026-11-11: Orion planning", ["## Transcript", "", `[0:05] Alex: ${quote}.`]));
      await consolidated(svc, rel);
    } finally {
      stop();
    }
    // The first five, in the model's order of importance.
    expect((await proposalsFrom(rel)).flatMap((p) => p.item?.events ?? []).sort()).toEqual([1, 2, 3, 4, 5].map((n) => `Freeze step ${n} logged`));
  });

  it("a capture already consolidated is not read again, when it changes or when Jarvis restarts", async () => {
    const calls = consolidationCalls();
    const before = await jobIds(svc);
    const proposals = (await proposalsFrom(STANDUP)).length;
    writeIntoBrain(svc, STANDUP, `${read(STANDUP)}\n> [0:50] Alex: One more thing we decided later.\n`);
    // A capture that arrives afterwards is consolidated, so the change above has been seen by then.
    const later = "evidence/captures/2026-11-11-granola-later.md";
    writeIntoBrain(svc, later, meetingCapture("Granola 2026-11-11: Later", ["Nothing much."]));
    await consolidated(svc, later);
    expect(consolidationCalls()).toBe(calls + 1);

    await svc.stop();
    svc = await startTestService({ stateDir: svc.stateDir, dataDir: svc.dataDir });
    await connectModel(svc);
    const afterRestart = "evidence/captures/2026-11-11-granola-after-restart.md";
    writeIntoBrain(svc, afterRestart, meetingCapture("Granola 2026-11-11: After restart", ["Nothing much."]));
    await consolidated(svc, afterRestart);
    expect(consolidationCalls()).toBe(calls + 2);
    expect(await startedSince(svc, before)).toEqual(expect.arrayContaining([later, afterRestart]));
    expect(await startedSince(svc, before)).toHaveLength(2);
    expect(await proposalsFrom(STANDUP)).toHaveLength(proposals);
  });

  it("a meeting capture that arrived while Jarvis was stopped is consolidated when it starts", async () => {
    await svc.stop();
    const rel = "evidence/captures/2026-11-11-granola-while-stopped.md";
    writeIntoBrain(svc, rel, meetingCapture("Granola 2026-11-11: While stopped", ["Nothing much."]));
    svc = await startTestService({ stateDir: svc.stateDir, dataDir: svc.dataDir });
    await connectModel(svc);
    await consolidated(svc, rel);
  });

  it("Slack, mail, Jira and calendar snapshots, and captures that are not meetings, never start Consolidation", async () => {
    const calls = consolidationCalls();
    const before = await jobIds(svc);
    const decision = "We decided to move the Orion cutover to January.";
    // What a Source refresh writes for each source.
    for (const [kind, label] of [
      ["slack", "Slack"],
      ["gmail", "Gmail"],
      ["jira", "Jira"],
      ["gcal", "Google Calendar"],
    ] as const) {
      svc.app.memory.writeConnectorSnapshot(kind, label, [`- ${decision}`]);
    }
    // A snapshot dropped in by hand, even one tagged as a meeting, is still a snapshot.
    writeIntoBrain(svc, "evidence/connectors/slack/2026-11-11-by-hand.md", meetingCapture("Slack 2026-11-11", [decision]));
    // A capture that is not a meeting.
    const note = "evidence/captures/2026-11-11-reading-list.md";
    writeIntoBrain(svc, note, meetingCapture("Reading list", [decision], ["reading"]));
    const meeting = "evidence/captures/2026-11-11-granola-after-snapshots.md";
    writeIntoBrain(svc, meeting, meetingCapture("Granola 2026-11-11: After snapshots", ["Nothing much."]));
    await consolidated(svc, meeting);
    expect(consolidationCalls()).toBe(calls + 1);
    expect(await startedSince(svc, before)).toEqual([meeting]);
  });

  it("meeting captures already in the Brain when Jarvis is set up are not consolidated", async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "jarvis-it-captures-")), "data");
    const old = "evidence/captures/2026-10-01-granola-old-meeting.md";
    mkdirSync(join(dataDir, "evidence/captures"), { recursive: true });
    writeFileSync(join(dataDir, old), meetingCapture("Granola 2026-10-01: Old meeting", ["We decided something long ago."]));
    const fresh = await startTestService({ dataDir });
    try {
      await setUp(fresh);
      await connectModel(fresh);
      const rel = "evidence/captures/2026-11-11-granola-first-new.md";
      writeIntoBrain(fresh, rel, meetingCapture("Granola 2026-11-11: First new", ["Nothing much."]));
      await consolidated(fresh, rel);
      expect(await startedSince(fresh, new Set())).toEqual([rel]);
    } finally {
      await fresh.stop();
    }
  });
});

describe("Consolidation from a meeting capture without a model", () => {
  it("makes no Proposal and says why", async () => {
    const bare = await startTestService();
    try {
      await setUp(bare);
      const rel = "evidence/captures/2026-11-11-granola-no-model.md";
      writeIntoBrain(bare, rel, meetingCapture("Granola 2026-11-11: No model", ["We decided to cut Orion over on Friday."]));
      const job = await consolidated(bare, rel);
      expect(job.result).toMatchObject({ capture: rel, proposals: 0, skipped: "no model", message: "No model is connected, so Jarvis made no Proposals from this meeting capture." });
      expect(await proposalsFrom(rel, bare)).toEqual([]);
    } finally {
      await bare.stop();
    }
  });
});

describe("Consolidation from a meeting capture with two Machines", () => {
  let world: TestWorld;
  afterAll(async () => {
    await world?.stop();
  });

  it("runs on the Machine where the capture arrived, and a Machine that receives it through Replication does not consolidate it again", async () => {
    world = await startMachines(["Work Laptop", "Home PC"]);
    const [laptop, pc] = world.machines as [TestMachine, TestMachine];
    for (const m of [laptop, pc]) {
      await m.post("/setup/identity", { name: "Alex", email: "alex@example.com", confirm: true });
      await connectModel(m);
    }
    const before = await jobIds(pc);
    const rel = "evidence/captures/2026-11-11-granola-hiring.md";
    const quote = "We decided to hire Jonas as the Orion data engineer";
    const stop = consolidationReplies(() => ({
      proposals: [{ item: { action: "create", type: "person", title: "Jonas", facts: [{ subject: "Role", value: "Orion data engineer" }] }, reason: "Hired in the meeting.", evidence: quote }],
    }));
    try {
      writeIntoBrain(laptop, rel, meetingCapture("Granola 2026-11-11: Hiring", [`[0:10] Alex: ${quote}.`]));
      await consolidated(laptop, rel);
    } finally {
      stop();
    }
    const [p] = await proposalsFrom(rel, laptop);
    expect(p).toMatchObject({ status: "proposed", target: "(new person: Jonas)", proposedOn: "Work Laptop" });
    // The capture and its Proposal reach the Home PC, which does not consolidate the capture again.
    await laptop.clock.advance(30_000);
    await pc.clock.advance(60_000);
    await until(() => existsSync(join(pc.dataDir, rel)));
    const own = "evidence/captures/2026-11-11-granola-home.md";
    writeIntoBrain(pc, own, meetingCapture("Granola 2026-11-11: Home", ["Nothing much."]));
    await consolidated(pc, own);
    expect(await startedSince(pc, before)).toEqual([own]);
    expect((await proposalsFrom(rel, pc)).map((q) => ({ id: q.id, proposedOn: q.proposedOn }))).toEqual([{ id: p!.id, proposedOn: "Work Laptop" }]);
  });
});
