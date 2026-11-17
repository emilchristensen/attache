import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RecentChangeView } from "@attache/contracts";
import { brainFile, startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { installFixtureModel, type FixtureModel } from "../fixtures/fixture-model.ts";
import { ORION, claudeCodeHome, connectModel, consolidated, consolidationProposals, consolidationReplies, consolidationWrites, endSession, setUp, writeIntoBrain } from "./consolidation-kit.ts";
import { meetingCapture } from "../fixtures/meeting-capture.ts";

/** ADR 0004: with the Consolidation switch on, the default, what Consolidation finds is written to the Brain straight away. */

let svc: TestService;
let fx: FixtureServer;
let model: FixtureModel;

const note = (rel: string) => brainFile(svc, rel);
const today = () => new Date().toISOString().slice(0, 10);

/** What Recent saves lists from one Harness session, newest first. */
async function changesFrom(sessionId: string): Promise<RecentChangeView[]> {
  const { changes } = await svc.get<{ changes: RecentChangeView[] }>("/memory/recent-changes?limit=200");
  return changes.filter((c) => c.source.sessionId === sessionId && !c.revertOf);
}

beforeAll(async () => {
  claudeCodeHome();
  fx = await startFixtureServer();
  model = installFixtureModel(fx);
  svc = await startTestService();
  await setUp(svc);
  await connectModel(svc, fx);
  await svc.post("/connections/claude-code/configure", { method: "hooks", fields: {} });
});
afterAll(async () => {
  await svc?.stop();
  await fx?.close();
});

describe("Consolidation writes what it finds", () => {
  it("a session that yields 8 changes writes all 8, each listed with the session as its source, written without review, and each reverts on its own", async () => {
    const quote = "We decided the Orion plan in full today";
    const facts = ["Owner", "Sponsor", "Budget", "Runbook", "Rollback window", "Region"].map((subject, i) => ({ subject, value: `Value ${i + 1}` }));
    const stop = consolidationReplies(model, () => ({
      proposals: [
        ...facts.map((f) => ({ item: { action: "update", path: ORION, facts: [f] }, reason: `The session set the ${f.subject}.`, evidence: quote })),
        { item: { action: "update", path: ORION, events: ["Plan agreed in full"] }, reason: "The plan was agreed.", evidence: quote },
        { item: { action: "create", type: "person", title: "Jonas Berg", facts: [{ subject: "Role", value: "Orion data engineer" }] }, reason: "Hired in the session.", evidence: quote },
      ],
    }));
    try {
      const r = await endSession(svc, "s-eight", [["What is the plan?", `${quote}, every part of it.`]]);
      expect(r.consolidate?.result).toMatchObject({ written: 8, proposals: 0 });
    } finally {
      stop();
    }
    // Written to the Brain, with no Proposal waiting.
    for (const f of facts) expect(note(ORION)).toContain(`- **${f.subject}** (${today()}): ${f.value}`);
    expect(note(ORION)).toContain("Plan agreed in full");
    expect(note("memory/people/jonas-berg.md")).toContain("Orion data engineer");
    expect(await consolidationProposals(svc, "s-eight")).toEqual([]);

    // The change log lists each change with the session as its source, marked as written without review.
    const changes = await changesFrom("s-eight");
    expect(changes).toHaveLength(8);
    for (const c of changes) expect(c.source).toMatchObject({ harness: "claude-code", sessionId: "s-eight", autoAccepted: true, label: "Consolidation of Claude Code session s-eight", consolidation: { from: "session", capture: null } });
    // Every change but the event can be reverted; events stay in History, as they do for a save.
    const revertible = changes.filter((c) => c.kind !== "append");
    expect(revertible).toHaveLength(7);
    for (const c of revertible) expect(c.revert).toEqual({ allowed: true, reason: null });

    // Each change reverts on its own, like a save: a fact goes back and the other seven stand, a created note goes away.
    const budget = changes.find((c) => c.subject === "Budget")!;
    await svc.post(`/memory/changes/${budget.id}/revert`);
    expect(note(ORION)).not.toContain(`- **Budget** (${today()}): Value 3`);
    for (const f of facts.filter((f) => f.subject !== "Budget")) expect(note(ORION)).toContain(`- **${f.subject}** (${today()}): ${f.value}`);
    const others = (await changesFrom("s-eight")).filter((c) => c.id !== budget.id && c.kind !== "append");
    expect(others).toHaveLength(6);
    for (const c of others) expect(c).toMatchObject({ revertedBy: null, revert: { allowed: true } });
    const created = changes.find((c) => c.kind === "create")!;
    await svc.post(`/memory/changes/${created.id}/revert`);
    expect(existsSync(join(svc.dataDir, "memory/people/jonas-berg.md"))).toBe(false);
  });

  it("a change that repeats an unchanged fact is not written, however the model writes the value back", async () => {
    const quote = "Orion is still Cutover planned, nothing new";
    const before = note(ORION);
    const stop = consolidationReplies(model, () => ({
      proposals: ["Cutover planned.", '"Cutover planned"', "**cutover PLANNED**"].map((value) => ({ item: { action: "update", path: ORION, facts: [{ subject: "status", value }] }, reason: "The session repeated the status.", evidence: quote })),
    }));
    try {
      const r = await endSession(svc, "s-repeat", [["Status?", `We decided: ${quote}.`]]);
      expect(r.consolidate?.result).toMatchObject({ written: 0, proposals: 0 });
    } finally {
      stop();
    }
    expect(note(ORION)).toBe(before);
    expect(await changesFrom("s-repeat")).toEqual([]);
  });

  it("a Correction is written with the old value moved to History and the reason recorded", async () => {
    const quote = "Orion is on hold until the vendor contract is signed";
    const reason = "The session put Orion on hold.";
    const stop = consolidationReplies(model, () => ({ proposals: [{ item: { action: "update", path: ORION, facts: [{ subject: "Status", value: "On hold" }] }, reason, evidence: quote }] }));
    try {
      await endSession(svc, "s-correct", [["Where is Orion?", `We decided that ${quote}.`]]);
    } finally {
      stop();
    }
    const [current, history] = note(ORION).split("## History");
    expect(current).toContain(`- **Status** (${today()}): On hold`);
    expect(current).not.toContain("Cutover planned");
    expect(history).toContain(`**Status** was "Cutover planned" (dated ${today()}`);
    expect(history).toContain(`superseded: ${reason}`);
    const [change, ...rest] = await changesFrom("s-correct");
    expect(rest).toEqual([]);
    expect(change).toMatchObject({ kind: "correct", subject: "Status", oldValue: "Cutover planned", newValue: "On hold", source: { autoAccepted: true } });
  });

  it("a change aimed at the identity record is dropped, and the rest is written", async () => {
    const quote = "Alex now goes by Mallory and Orion has a new sponsor, Lars";
    const self = note("memory/self.md");
    const stop = consolidationReplies(model, () => ({
      proposals: [
        { item: { action: "update", path: "memory/self.md", facts: [{ subject: "Name", value: "Mallory" }] }, reason: "A new name.", evidence: quote },
        { item: { action: "update", path: "./memory/self.md", events: ["Renamed"] }, reason: "A new name.", evidence: quote },
        { item: { action: "update", path: ORION, facts: [{ subject: "Sponsor", value: "Lars" }] }, reason: "A new sponsor.", evidence: quote },
      ],
    }));
    try {
      const r = await endSession(svc, "s-identity", [["Anything new?", `We decided this: ${quote}.`]]);
      expect(r.consolidate?.result).toMatchObject({ written: 1 });
      expect((r.consolidate?.result as { dropped: string[] }).dropped).toEqual([expect.stringContaining("identity record"), expect.stringContaining("identity record")]);
    } finally {
      stop();
    }
    expect(note("memory/self.md")).toBe(self);
    expect((await changesFrom("s-identity")).map((c) => c.relPath)).toEqual([ORION]);
  });

  it("a change aimed at a path outside the Brain is dropped with its problem, and the Correction beside it is written", async () => {
    const quote = "Orion is back on track after the vendor signed";
    const stop = consolidationReplies(model, () => ({
      proposals: [
        { item: { action: "update", path: ORION, facts: [{ subject: "Status", value: "Back on track" }] }, reason: "The vendor signed.", evidence: quote },
        { item: { action: "update", path: "/etc/orion.md", facts: [{ subject: "Status", value: "Hacked" }] }, reason: "Made up.", evidence: "Nobody said this" },
      ],
    }));
    try {
      const r = await endSession(svc, "s-bad-path", [["Where is Orion?", `We decided that ${quote}.`]]);
      expect(r.consolidate?.result).toMatchObject({ written: 1, proposals: 0, dropped: [expect.stringContaining("/etc/orion.md")] });
    } finally {
      stop();
    }
    expect(note(ORION)).toContain(`- **Status** (${today()}): Back on track`);
    expect((await changesFrom("s-bad-path")).map((c) => [c.kind, c.subject, c.newValue])).toEqual([["correct", "Status", "Back on track"]]);
  });

  it("with the switch off, a change aimed at a path outside the Brain is dropped with its problem, and the rest becomes a Proposal", async () => {
    const quote = "We decided the Orion escalation contact is Mette";
    await consolidationWrites(svc, false);
    const stop = consolidationReplies(model, () => ({
      proposals: [
        { item: { action: "update", path: ORION, facts: [{ subject: "Escalation contact", value: "Mette" }] }, reason: "The session named the contact.", evidence: quote },
        { item: { action: "update", path: "../outside/orion.md", facts: [{ subject: "Escalation contact", value: "Mette" }] }, reason: "The same, elsewhere.", evidence: quote },
      ],
    }));
    try {
      const r = await endSession(svc, "s-bad-path-off", [["Who do we call?", `${quote}.`]]);
      expect(r.consolidate?.result).toMatchObject({ written: 0, proposals: 1, dropped: [expect.stringContaining("../outside/orion.md")] });
    } finally {
      stop();
      await consolidationWrites(svc, true);
    }
    expect((await consolidationProposals(svc, "s-bad-path-off")).map((p) => p.item)).toEqual([
      { action: "update", path: ORION, facts: [{ subject: "Escalation contact", value: "Mette", reason: "The session named the contact." }] },
    ]);
  });
});

describe("Consolidation gives a fact one value per run", () => {
  const fact = (subject: string, value: string, evidence: string) => ({ item: { action: "update", path: ORION, facts: [{ subject, value }] }, reason: `The ${subject} was set.`, evidence });

  it("when two changes in one reply give a fact different values, the first is written and the other is dropped with its problem", async () => {
    const quote = "We decided Orion runs in Oslo, or maybe Bergen, and Kari owns the runbook";
    const stop = consolidationReplies(model, () => ({ proposals: [fact("Region", "Oslo", quote), fact("Region", "Bergen", quote), fact("Runbook owner", "Kari", quote)] }));
    try {
      const r = await endSession(svc, "s-two-values", [["Where does Orion run?", `${quote}.`]]);
      expect(r.consolidate?.result).toMatchObject({ written: 2, dropped: [expect.stringMatching(/"Region".*"Bergen".*"Oslo"/)] });
    } finally {
      stop();
    }
    expect(note(ORION)).toContain(`- **Region** (${today()}): Oslo`);
    expect(note(ORION)).not.toContain("Bergen");
    expect(note(ORION)).toContain(`- **Runbook owner** (${today()}): Kari`);
    expect((await changesFrom("s-two-values")).map((c) => [c.subject, c.newValue]).sort()).toEqual([
      ["Region", "Oslo"],
      ["Runbook owner", "Kari"],
    ]);
  });

  it("in a meeting read in parts, the value from the later part is written", async () => {
    const rel = "evidence/captures/2026-11-12-granola-long-orion-review.md";
    const early = "Alex: The Orion data centre is Dublin";
    const late = "Alex: Correction, the Orion data centre is Madrid";
    const filler = Array.from({ length: 1200 }, (_, i) => `[${i}:00] Priya: Background on the migration that decides nothing, line ${i} of the long review.`);
    const stop = consolidationReplies(model, (call) => ({
      proposals: [...(call.user.includes(early) ? [fact("Data centre", "Dublin", early)] : []), ...(call.user.includes(late) ? [fact("Data centre", "Madrid", late)] : [])],
    }));
    try {
      writeIntoBrain(svc, rel, meetingCapture("Granola 2026-11-12: Long Orion review", [`[0:01] ${early}.`, ...filler, `[59:00] ${late}.`]));
      const job = await consolidated(svc, rel);
      expect(job.result).toMatchObject({ written: 1, dropped: [expect.stringMatching(/"Data centre".*"Dublin".*"Madrid"/)] });
    } finally {
      stop();
    }
    expect(note(ORION)).toContain(`- **Data centre** (${today()}): Madrid`);
    expect(note(ORION)).not.toContain("Dublin");
  });

  it("in a meeting read in parts, when both parts make the same new note, the one from the later part is written", async () => {
    const rel = "evidence/captures/2026-11-12-granola-long-freeze-review.md";
    const early = "Alex: We decided the Orion freeze window is two weeks";
    const late = "Alex: Correction, we decided the Orion freeze window is three weeks";
    const filler = Array.from({ length: 1200 }, (_, i) => `[${i}:00] Priya: Background on the freeze that decides nothing, line ${i} of the long review.`);
    const freeze = (length: string, evidence: string) => ({ item: { action: "create", type: "decision", title: "Orion freeze window", facts: [{ subject: "Length", value: length }] }, reason: "The meeting set the freeze window.", evidence });
    const stop = consolidationReplies(model, (call) => ({
      proposals: [...(call.user.includes(early) ? [freeze("Two weeks", early)] : []), ...(call.user.includes(late) ? [freeze("Three weeks", late)] : [])],
    }));
    try {
      writeIntoBrain(svc, rel, meetingCapture("Granola 2026-11-12: Long freeze review", [`[0:01] ${early}.`, ...filler, `[59:00] ${late}.`]));
      const job = await consolidated(svc, rel);
      expect(job.result).toMatchObject({ written: 1, dropped: [expect.stringMatching(/"Orion freeze window".*kept instead/)] });
    } finally {
      stop();
    }
    expect(note("memory/decisions/orion-freeze-window.md")).toContain(`- **Length** (${today()}): Three weeks`);
    expect(note("memory/decisions/orion-freeze-window.md")).not.toContain("Two weeks");
  });

  it("in a meeting read in parts, a later value whose evidence is not in the meeting does not push out the earlier one", async () => {
    const rel = "evidence/captures/2026-11-16-granola-long-owner-review.md";
    const early = "Alex: Priya owns the Orion rollout";
    const filler = Array.from({ length: 1200 }, (_, i) => `[${i}:00] Lars: Background on the rollout that decides nothing, line ${i} of the long review.`);
    const stop = consolidationReplies(model, (call) => ({
      // The model reads the second part wrong and quotes a line nobody said.
      proposals: call.user.includes(early) ? [fact("Rollout owner", "Priya", early)] : [fact("Rollout owner", "Lars", "Alex: Lars owns the Orion rollout")],
    }));
    try {
      writeIntoBrain(svc, rel, meetingCapture("Granola 2026-11-16: Long owner review", [`[0:01] ${early}.`, ...filler, "[59:00] Alex: That is all for today."]));
      const job = await consolidated(svc, rel);
      expect(job.result).toMatchObject({ written: 1, dropped: [expect.stringMatching(/evidence is not quoted from the meeting/)] });
    } finally {
      stop();
    }
    expect(note(ORION)).toContain(`- **Rollout owner** (${today()}): Priya`);
    expect(note(ORION)).not.toContain("Lars owns");
  });

  it("in a meeting read in parts, a later new note whose evidence is not in the meeting does not push out the earlier one", async () => {
    const rel = "evidence/captures/2026-11-16-granola-long-cutover-review.md";
    const early = "Alex: We decided the Orion cutover happens on a Sunday";
    const filler = Array.from({ length: 1200 }, (_, i) => `[${i}:00] Priya: Background on the cutover that decides nothing, line ${i} of the long review.`);
    const cutover = (day: string, evidence: string) => ({ item: { action: "create", type: "decision", title: "Orion cutover day", facts: [{ subject: "Day", value: day }] }, reason: "The meeting set the cutover day.", evidence });
    const stop = consolidationReplies(model, (call) => ({
      proposals: call.user.includes(early) ? [cutover("Sunday", early)] : [cutover("Saturday", "Alex: We decided the Orion cutover happens on a Saturday")],
    }));
    try {
      writeIntoBrain(svc, rel, meetingCapture("Granola 2026-11-16: Long cutover review", [`[0:01] ${early}.`, ...filler, "[59:00] Alex: That is all for today."]));
      const job = await consolidated(svc, rel);
      expect(job.result).toMatchObject({ written: 1, dropped: [expect.stringMatching(/evidence is not quoted from the meeting/)] });
    } finally {
      stop();
    }
    expect(note("memory/decisions/orion-cutover-day.md")).toContain(`- **Day** (${today()}): Sunday`);
  });

  it("with the switch off, each value still becomes its own Proposal for the owner to choose", async () => {
    const quote = "We decided Orion is hosted on Azure, or AWS";
    await consolidationWrites(svc, false);
    const stop = consolidationReplies(model, () => ({ proposals: [fact("Hosting", "Azure", quote), fact("Hosting", "AWS", quote)] }));
    try {
      const r = await endSession(svc, "s-two-proposals", [["Hosting?", `${quote}.`]]);
      expect(r.consolidate?.result).toMatchObject({ written: 0, proposals: 2, dropped: [] });
    } finally {
      stop();
      await consolidationWrites(svc, true);
    }
    expect((await consolidationProposals(svc, "s-two-proposals")).map((p) => (p.item as { facts: Array<{ value: string }> }).facts[0]!.value).sort()).toEqual(["AWS", "Azure"]);
  });
});

describe("Consolidation writes what it finds in a meeting capture", () => {
  it("each change records the capture it came from, cites the lines it rests on, and is marked as written without review", async () => {
    const rel = "evidence/captures/2026-11-11-granola-orion-stand-up.md";
    const quote = "Priya leads the Orion cutover from now on";
    const stop = consolidationReplies(model, () => ({ proposals: [{ item: { action: "update", path: ORION, facts: [{ subject: "Cutover lead", value: "Priya" }] }, reason: "The stand-up named the cutover lead.", evidence: quote }] }));
    try {
      writeIntoBrain(svc, rel, meetingCapture("Granola 2026-11-11: Orion stand-up", ["## Transcript", "", "[0:01] Alex: Morning.", `[0:12] Alex: We agreed that ${quote}.`]));
      const job = await consolidated(svc, rel);
      expect(job.result).toMatchObject({ capture: rel, written: 1, proposals: 0 });
    } finally {
      stop();
    }
    // The fact cites the capture's lines it rests on.
    expect(note(ORION)).toMatch(new RegExp(`- \\*\\*Cutover lead\\*\\* \\(${today()}\\): Priya — source: .*\\(capture: ${rel}#L\\d+`));
    // Home's Recently added lists it once, written without review, naming the meeting it came from.
    const { changes } = await svc.get<{ changes: RecentChangeView[] }>("/memory/recent-changes?unreviewed=1");
    const meeting = { relPath: rel, title: "Granola 2026-11-11: Orion stand-up" };
    const fromMeeting = changes.filter((c) => c.source.consolidation?.capture?.relPath === rel);
    expect(fromMeeting).toHaveLength(1);
    expect(fromMeeting[0]).toMatchObject({ relPath: ORION, subject: "Cutover lead", newValue: "Priya", source: { harness: null, sessionId: null, label: `Consolidation of meeting “${meeting.title}”`, autoAccepted: true, consolidation: { from: "meeting", capture: meeting } } });
  });
});

describe("The Consolidation switch", () => {
  it("is on by default, and with it off the same session makes Proposals instead and writes nothing", async () => {
    expect(await svc.get("/consolidation")).toEqual({ autoAccept: true });
    expect(await svc.put("/consolidation/auto-accept", { autoAccept: false })).toEqual({ autoAccept: false });
    expect(await svc.get("/consolidation")).toEqual({ autoAccept: false });
    const quote = "We decided the Orion budget is 40k";
    const before = note(ORION);
    const stop = consolidationReplies(model, (call) => {
      // The model is told its changes wait for the owner.
      expect(call.system).toContain("nothing is written without that click");
      return { proposals: [{ item: { action: "update", path: ORION, facts: [{ subject: "Budget", value: "40k" }] }, reason: "The session set the budget.", evidence: quote }] };
    });
    try {
      const r = await endSession(svc, "s-off", [["Budget?", `${quote}.`]]);
      expect(r.consolidate?.result).toMatchObject({ written: 0, proposals: 1 });
    } finally {
      stop();
      await svc.put("/consolidation/auto-accept", { autoAccept: true });
    }
    expect(note(ORION)).toBe(before);
    expect(await changesFrom("s-off")).toEqual([]);
    expect((await consolidationProposals(svc, "s-off")).map((p) => ({ status: p.status, item: p.item }))).toEqual([
      { status: "proposed", item: { action: "update", path: ORION, facts: [{ subject: "Budget", value: "40k", reason: "The session set the budget." }] } },
    ]);
  });

  it("switched off while the model is still reading, the run makes Proposals and writes nothing", async () => {
    const quote = "We decided the Orion steering group is Dana and Lars";
    const item = { action: "update", path: ORION, facts: [{ subject: "Steering group", value: "Dana and Lars" }] };
    let asked!: () => void;
    let answer!: () => void;
    const reading = new Promise<void>((r) => (asked = r));
    const answered = new Promise<void>((r) => (answer = r));
    const stop = model.respond((call) => {
      if (!/Consolidation/.test(call.system)) return null;
      asked();
      return answered.then(() => JSON.stringify({ proposals: [{ item, reason: "The session named the steering group.", evidence: quote }] }));
    });
    const before = note(ORION);
    try {
      const ended = endSession(svc, "s-switched", [["Who steers Orion?", `${quote}.`]]);
      await reading;
      // The owner switches Consolidation off in Settings before the model answers.
      await consolidationWrites(svc, false);
      answer();
      const r = await ended;
      expect(r.consolidate?.result).toMatchObject({ written: 0, proposals: 1 });
    } finally {
      answer();
      stop();
      await consolidationWrites(svc, true);
    }
    expect(note(ORION)).toBe(before);
    expect(await changesFrom("s-switched")).toEqual([]);
    expect((await consolidationProposals(svc, "s-switched")).map((p) => p.status)).toEqual(["proposed"]);
  });

  it("is kept on this Machine across a restart", async () => {
    const machine = await startTestService();
    await machine.put("/consolidation/auto-accept", { autoAccept: false }).finally(() => machine.stop());
    const again = await startTestService({ stateDir: machine.stateDir, dataDir: machine.dataDir });
    try {
      expect(await again.get("/consolidation")).toEqual({ autoAccept: false });
    } finally {
      await again.stop();
    }
  });
});
