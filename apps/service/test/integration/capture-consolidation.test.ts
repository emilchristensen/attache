import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brainFile, startTestService, type TestService } from "./harness.ts";
import { startMachines, type TestMachine, type TestWorld } from "./machines.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { installFixtureModel, type FixtureModel } from "../fixtures/fixture-model.ts";
import { ORION, captureJobs, connectModel, consolidated, consolidationProposals, consolidationReplies, consolidationWrites, setUp, until, writeIntoBrain } from "./consolidation-kit.ts";
import { meetingCapture } from "../fixtures/meeting-capture.ts";

/**
 * Consolidation of meeting captures with its switch off on the Machine: what
 * it finds becomes Proposals that wait for the owner. With the switch on, the
 * default, it writes them instead: `consolidation-writes.test.ts`.
 */

let svc: TestService;
let fx: FixtureServer;
let model: FixtureModel;

const consolidationCalls = () => model.calls.filter((c) => /Consolidation/.test(c.system)).length;

/** A Machine with the owner's identity and the Orion note, whose Consolidation makes Proposals. */
async function setUpProposing(service: TestService) {
  await setUp(service);
  await consolidationWrites(service, false);
}

/** The captures Consolidation was started for since `before` was taken, finished or not. */
async function startedSince(service: TestService, before: ReadonlySet<string>): Promise<Array<string | null>> {
  return (await captureJobs(service)).filter((j) => !before.has(j.id)).map((j) => (j.result as { capture?: string } | null)?.capture ?? null);
}

const jobIds = async (service: TestService) => new Set((await captureJobs(service)).map((j) => j.id));

beforeAll(async () => {
  fx = await startFixtureServer();
  model = installFixtureModel(fx);
  svc = await startTestService();
  await setUpProposing(svc);
  await connectModel(svc, fx);
});
afterAll(async () => {
  await svc?.stop();
  await fx?.close();
});

describe("Consolidation from a meeting capture", () => {
  const STANDUP = "evidence/captures/2026-11-11-granola-orion-stand-up.md";

  it("a new meeting capture yields Proposals that cite the capture and the lines they rest on, and wait for the owner", async () => {
    const stop = consolidationReplies(model, (call) => {
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
    const before = brainFile(svc, ORION);
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
    const made = await consolidationProposals(svc, STANDUP);
    expect(made.map((p) => p.reason).sort()).toEqual(["Priya confirmed the end of the freeze.", "The stand-up moved the cutover."]);
    const lines = brainFile(svc, STANDUP).split("\n");
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
    expect(brainFile(svc, ORION)).toBe(before);
  });

  it("what Consolidation drops from a meeting is reported as the meeting's, never a session's", async () => {
    const rel = "evidence/captures/2026-11-11-granola-orion-retro.md";
    const stop = consolidationReplies(model, () => ({
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
    const stop = consolidationReplies(model, (call) => {
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
    const [p, ...rest] = await consolidationProposals(svc, rel);
    expect(rest).toEqual([]);
    expect(p).toMatchObject({
      status: "proposed",
      target: ORION,
      reason,
      evidence: quote,
      corrections: [{ subject: "Status", was: { value: "Cutover planned", date: today, review: null }, value: "On hold" }],
    });
    await svc.post(`/memory/proposals/${p!.id}/apply`);
    const [current, history] = brainFile(svc, ORION).split("## History");
    expect(current).toContain(`- **Status** (${today}): On hold`);
    expect(history).toContain(`**Status** was "Cutover planned" (dated ${today}`);
    expect(history).toContain(`superseded: ${reason}`);
  });

  it("a capture already consolidated is not read again, when it changes or when Attache restarts", async () => {
    const calls = consolidationCalls();
    const before = await jobIds(svc);
    const proposals = (await consolidationProposals(svc, STANDUP)).length;
    writeIntoBrain(svc, STANDUP, `${brainFile(svc, STANDUP)}\n> [0:50] Alex: One more thing we decided later.\n`);
    // A capture that arrives afterwards is consolidated, so the change above has been seen by then.
    const later = "evidence/captures/2026-11-11-granola-later.md";
    writeIntoBrain(svc, later, meetingCapture("Granola 2026-11-11: Later", ["Nothing much."]));
    await consolidated(svc, later);
    expect(consolidationCalls()).toBe(calls + 1);

    await svc.stop();
    svc = await startTestService({ stateDir: svc.stateDir, dataDir: svc.dataDir });
    await connectModel(svc, fx);
    const afterRestart = "evidence/captures/2026-11-11-granola-after-restart.md";
    writeIntoBrain(svc, afterRestart, meetingCapture("Granola 2026-11-11: After restart", ["Nothing much."]));
    await consolidated(svc, afterRestart);
    expect(consolidationCalls()).toBe(calls + 2);
    expect(await startedSince(svc, before)).toEqual(expect.arrayContaining([later, afterRestart]));
    expect(await startedSince(svc, before)).toHaveLength(2);
    expect(await consolidationProposals(svc, STANDUP)).toHaveLength(proposals);
  });

  it("a meeting capture that arrived while Attache was stopped is consolidated when it starts", async () => {
    await svc.stop();
    const rel = "evidence/captures/2026-11-11-granola-while-stopped.md";
    writeIntoBrain(svc, rel, meetingCapture("Granola 2026-11-11: While stopped", ["Nothing much."]));
    svc = await startTestService({ stateDir: svc.stateDir, dataDir: svc.dataDir });
    await connectModel(svc, fx);
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

  it("meeting captures already in the Brain when Attache is set up are not consolidated", async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), "attache-it-captures-")), "data");
    const old = "evidence/captures/2026-10-01-granola-old-meeting.md";
    mkdirSync(join(dataDir, "evidence/captures"), { recursive: true });
    writeFileSync(join(dataDir, old), meetingCapture("Granola 2026-10-01: Old meeting", ["We decided something long ago."]));
    const fresh = await startTestService({ dataDir });
    try {
      await setUpProposing(fresh);
      await connectModel(fresh, fx);
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
      await setUpProposing(bare);
      const rel = "evidence/captures/2026-11-11-granola-no-model.md";
      writeIntoBrain(bare, rel, meetingCapture("Granola 2026-11-11: No model", ["We decided to cut Orion over on Friday."]));
      const job = await consolidated(bare, rel);
      expect(job.result).toMatchObject({ capture: rel, proposals: 0, skipped: "no model", message: "No model is connected, so Attache did not consolidate this meeting capture. Connect a model in Connections to consolidate the next one." });
      expect(await consolidationProposals(bare, rel)).toEqual([]);
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
      await connectModel(m, fx);
      await consolidationWrites(m, false);
    }
    const before = await jobIds(pc);
    const rel = "evidence/captures/2026-11-11-granola-hiring.md";
    const quote = "We decided to hire Jonas as the Orion data engineer";
    const stop = consolidationReplies(model, () => ({
      proposals: [{ item: { action: "create", type: "person", title: "Jonas", facts: [{ subject: "Role", value: "Orion data engineer" }] }, reason: "Hired in the meeting.", evidence: quote }],
    }));
    try {
      writeIntoBrain(laptop, rel, meetingCapture("Granola 2026-11-11: Hiring", [`[0:10] Alex: ${quote}.`]));
      await consolidated(laptop, rel);
    } finally {
      stop();
    }
    const [p] = await consolidationProposals(laptop, rel);
    expect(p).toMatchObject({ status: "proposed", target: "(new person: Jonas)", proposedOn: "Work Laptop" });
    // The capture and its Proposal reach the Home PC, which does not consolidate the capture again.
    await laptop.clock.advance(30_000);
    await pc.clock.advance(60_000);
    await until(() => existsSync(join(pc.dataDir, rel)));
    const own = "evidence/captures/2026-11-11-granola-home.md";
    writeIntoBrain(pc, own, meetingCapture("Granola 2026-11-11: Home", ["Nothing much."]));
    await consolidated(pc, own);
    expect(await startedSince(pc, before)).toEqual([own]);
    expect((await consolidationProposals(pc, rel)).map((q) => ({ id: q.id, proposedOn: q.proposedOn }))).toEqual([{ id: p!.id, proposedOn: "Work Laptop" }]);
  });
});
