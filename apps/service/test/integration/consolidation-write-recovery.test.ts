import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, lstatSync, mkdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobView, RecentChangeView } from "@attache/contracts";
import { brainFile, diedBeforeTheJobFinished, startTestService, testFolder, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { installFixtureModel, type FixtureModel } from "../fixtures/fixture-model.ts";
import { ORION, captureJobs, claudeCodeHome, connectModel, consolidated, consolidationProposals, consolidationReplies, consolidationWrites, endSession, finished, setUp, until, writeIntoBrain } from "./consolidation-kit.ts";
import { meetingCapture } from "../fixtures/meeting-capture.ts";

/**
 * ADR 0004: a Consolidation run that stops partway through writing, because a
 * write failed or Attache stopped, writes the rest when it runs again, and
 * writes nothing twice.
 */

let svc: TestService;
let fx: FixtureServer;
let model: FixtureModel;

const DECISIONS = "memory/decisions";
const today = () => new Date().toISOString().slice(0, 10);

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

/**
 * Make every write into the Brain's decisions folder fail for now, as a
 * folder the owner's file sync briefly locks does: a file stands where the folder was.
 */
function blockDecisions(service: TestService) {
  rmSync(join(service.dataDir, DECISIONS), { recursive: true, force: true });
  writeFileSync(join(service.dataDir, DECISIONS), "");
}

function unblockDecisions(service: TestService) {
  const folder = join(service.dataDir, DECISIONS);
  if (statSync(folder, { throwIfNoEntry: false })?.isFile()) rmSync(folder);
  mkdirSync(folder, { recursive: true });
}

const NOTES = "memory/notes";
const outside = testFolder("outside-the-brain");

/**
 * Make the Brain's notes folder a link to a folder outside the Brain, as an
 * owner's misplaced symlink would: a note written there is refused, never followed.
 */
function leadNotesOutsideTheBrain(service: TestService) {
  const folder = join(service.dataDir, NOTES);
  rmSync(folder, { recursive: true, force: true });
  // A junction on Windows needs no extra rights; elsewhere the type is ignored.
  symlinkSync(outside, folder, "junction");
}

function restoreNotes(service: TestService) {
  const folder = join(service.dataDir, NOTES);
  if (lstatSync(folder, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(folder);
  mkdirSync(folder, { recursive: true });
}

/**
 * A meeting whose Consolidation makes two changes: a fact on Orion, then a new
 * decision note. Returns what stops the model answering it.
 */
function meetingWithTwoChanges(rel: string, lead: string, decision: string): () => void {
  const said = `${lead} leads the Orion cutover, and we decided ${decision}`;
  const stop = consolidationReplies(model, () => ({
    proposals: [
      { item: { action: "update", path: ORION, facts: [{ subject: "Cutover lead", value: lead }] }, reason: "The meeting named the cutover lead.", evidence: said },
      { item: { action: "create", type: "decision", title: decision, facts: [{ subject: "Status", value: "Agreed" }] }, reason: "The meeting made a decision.", evidence: said },
    ],
  }));
  writeIntoBrain(svc, rel, meetingCapture(`Granola: ${decision}`, [`[0:05] Alex: ${said}.`]));
  return stop;
}

/**
 * A meeting whose Consolidation drops a new note it cannot write, then fails on
 * a decision note and is tried again once the decisions folder is back.
 * Returns what the finished run reports it dropped.
 */
async function droppedNoteThenFailed(name: string, noteTitle: string): Promise<string[]> {
  const rel = `evidence/captures/${name}.md`;
  const said = `We decided ${noteTitle} is settled, and noted ${noteTitle}`;
  const note = { item: { action: "create", type: "note", title: noteTitle, facts: [{ subject: "Status", value: "Settled" }] }, reason: "The meeting noted it.", evidence: said };
  const decision = { item: { action: "create", type: "decision", title: `${noteTitle} is settled`, facts: [{ subject: "Status", value: "Agreed" }] }, reason: "The meeting made a decision.", evidence: said };
  const stop = consolidationReplies(model, () => ({ proposals: [note, decision] }));
  leadNotesOutsideTheBrain(svc);
  blockDecisions(svc);
  try {
    writeIntoBrain(svc, rel, meetingCapture(`Granola: ${noteTitle}`, [`[0:05] Alex: ${said}.`]));
    // The note cannot be written outside the Brain, so it is dropped; then the decision fails and the run waits to be tried again.
    await failedOnce();
    unblockDecisions(svc);
    const job = await consolidated(svc, rel);
    expect(job.result).toMatchObject({ capture: rel, written: 1 });
    return (job.result as { dropped: string[] }).dropped;
  } finally {
    unblockDecisions(svc);
    restoreNotes(svc);
    stop();
  }
}

/** The capture job that failed partway and waits to be tried again. */
const failedOnce = () => until(async () => (await captureJobs(svc)).find((j: JobView) => j.status === "queued" && j.error));

/** What Home's Recently added lists from one meeting capture. */
async function changesFrom(rel: string): Promise<RecentChangeView[]> {
  const { changes } = await svc.get<{ changes: RecentChangeView[] }>("/memory/recent-changes?unreviewed=1");
  return changes.filter((c) => c.source.consolidation?.capture?.relPath === rel);
}

describe("Consolidation that stops partway through writing", () => {
  it("writes the change that failed when it is tried again, and the one already written stays written once", async () => {
    const rel = "evidence/captures/2026-11-12-granola-retry.md";
    const decision = "Orion keeps the vendor freeze";
    blockDecisions(svc);
    const stop = meetingWithTwoChanges(rel, "Priya", decision);
    try {
      // The fact on Orion is written; the decision note cannot be, so the run fails and waits to be tried again.
      await failedOnce();
      expect(brainFile(svc, ORION)).toContain(`- **Cutover lead** (${today()}): Priya`);
      unblockDecisions(svc);
      const job = await consolidated(svc, rel);
      // The fact the first attempt wrote is written, not dropped as a repeat.
      expect(job.result).toMatchObject({ capture: rel, written: 2, dropped: [] });
    } finally {
      unblockDecisions(svc);
      stop();
    }
    expect(brainFile(svc, `${DECISIONS}/orion-keeps-the-vendor-freeze.md`)).toContain("Agreed");
    expect((await changesFrom(rel)).map((c) => [c.relPath, c.kind, c.subject]).sort()).toEqual([
      [`${DECISIONS}/orion-keeps-the-vendor-freeze.md`, "create", null],
      [ORION, "correct", "Cutover lead"],
    ].sort());
  });

  it("after Attache stops and starts again, writes the rest, and each change appears exactly once", async () => {
    const rel = "evidence/captures/2026-11-12-granola-restart.md";
    const decision = "Orion moves to the new region";
    blockDecisions(svc);
    const stop = meetingWithTwoChanges(rel, "Lars", decision);
    try {
      await failedOnce();
      await svc.stop();
      unblockDecisions(svc);
      svc = await startTestService({ stateDir: svc.stateDir, dataDir: svc.dataDir });
      const job = await consolidated(svc, rel);
      expect(job.result).toMatchObject({ capture: rel, written: 2, dropped: [] });
    } finally {
      unblockDecisions(svc);
      stop();
    }
    expect(existsSync(join(svc.dataDir, `${DECISIONS}/orion-moves-to-the-new-region.md`))).toBe(true);
    expect(brainFile(svc, ORION).match(/\*\*Cutover lead\*\* \([^)]*\): Lars/g)).toHaveLength(1);
    const changes = await changesFrom(rel);
    expect(changes.map((c) => c.kind).sort()).toEqual(["correct", "create"]);
  });

  it("tried again, writes what the model said the first time, and never asks the model again", async () => {
    const rel = "evidence/captures/2026-11-15-granola-release-manager.md";
    const said = "Ingrid Holm is the Orion release manager, and we decided Orion ships on Thursdays";
    let readings = 0;
    // Asked again, the model would name her in full: a second value for the same fact.
    const stop = consolidationReplies(model, () => ({
      proposals: [
        { item: { action: "update", path: ORION, facts: [{ subject: "Release manager", value: readings++ === 0 ? "Ingrid" : "Ingrid Holm" }] }, reason: "The meeting named the release manager.", evidence: said },
        { item: { action: "create", type: "decision", title: "Orion ships on Thursdays", facts: [{ subject: "Status", value: "Agreed" }] }, reason: "The meeting made a decision.", evidence: said },
      ],
    }));
    blockDecisions(svc);
    try {
      writeIntoBrain(svc, rel, meetingCapture("Granola: Orion release manager", [`[0:05] Alex: ${said}.`]));
      await failedOnce();
      unblockDecisions(svc);
      const job = await consolidated(svc, rel);
      expect(job.result).toMatchObject({ capture: rel, written: 2 });
    } finally {
      unblockDecisions(svc);
      stop();
    }
    expect(readings).toBe(1);
    expect(brainFile(svc, ORION)).toContain(`- **Release manager** (${today()}): Ingrid`);
    expect(brainFile(svc, ORION)).not.toContain("Ingrid Holm");
    expect((await changesFrom(rel)).filter((c) => c.subject === "Release manager").map((c) => c.newValue)).toEqual(["Ingrid"]);
  });

  it("counts only its own changes, not those a later part of the same session wrote in between", async () => {
    const sessionId = "s-two-parts";
    const first = "Nadia owns the Orion migration and we decided Orion drops the legacy API";
    const later = "Henrik owns Orion QA from now on";
    const decision = "Orion drops the legacy API";
    const stop = consolidationReplies(model, (call) =>
      call.user.includes(later)
        ? { proposals: [{ item: { action: "update", path: ORION, facts: [{ subject: "QA owner", value: "Henrik" }] }, reason: "The session named the QA owner.", evidence: later }] }
        : {
            proposals: [
              { item: { action: "update", path: ORION, facts: [{ subject: "Migration owner", value: "Nadia" }] }, reason: "The session named the owner.", evidence: first },
              { item: { action: "create", type: "decision", title: decision, facts: [{ subject: "Status", value: "Agreed" }] }, reason: "The session made a decision.", evidence: first },
            ],
          },
    );
    const exchanges: Array<[string, string]> = [["Who owns Orion?", `${first}.`]];
    blockDecisions(svc);
    try {
      // The first part writes its fact, fails on the decision note, and waits to be tried again; the owner stops it for now.
      const { laterJobs } = await endSession(svc, sessionId, exchanges, { awaitConsolidation: false });
      const partOne = laterJobs[0]!;
      await until(async () => (await svc.get<{ job: JobView }>(`/jobs/${partOne.id}`)).job.error);
      await svc.post(`/jobs/${partOne.id}/cancel`);
      // The session goes on and ends again; its later part writes one change of its own.
      const partTwo = await endSession(svc, sessionId, [...exchanges, ["And QA?", `We decided this: ${later}.`]]);
      expect(partTwo.consolidate?.result).toMatchObject({ written: 1 });
      // The owner tries the first part again once its folder is back.
      unblockDecisions(svc);
      await svc.post(`/jobs/${partOne.id}/retry`);
      const done = await until(async () => {
        const { job } = await svc.get<{ job: JobView }>(`/jobs/${partOne.id}`);
        return finished(job) && job;
      });
      expect(done).toMatchObject({ status: "succeeded", result: { written: 2, proposals: 0, dropped: [] } });
    } finally {
      unblockDecisions(svc);
      stop();
    }
    expect(brainFile(svc, `${DECISIONS}/orion-drops-the-legacy-api.md`)).toContain("Agreed");
  });

  it("tried again, does not write a change its first attempt dropped because the change's note did not exist yet", async () => {
    const rel = "evidence/captures/2026-11-17-granola-rollback.md";
    const said = "We noted the Orion rollback plan, Tove owns it, and we decided Orion keeps a rollback plan";
    const note = `${NOTES}/orion-rollback-plan.md`;
    // The model makes a note and, in the same answer, sets a fact on the note it is only now making; then a decision.
    const stop = consolidationReplies(model, () => ({
      proposals: [
        { item: { action: "create", type: "note", title: "Orion rollback plan", facts: [{ subject: "Status", value: "Drafted" }] }, reason: "The meeting noted the plan.", evidence: said },
        { item: { action: "update", path: note, facts: [{ subject: "Owner", value: "Tove" }] }, reason: "The meeting named the owner.", evidence: said },
        { item: { action: "create", type: "decision", title: "Orion keeps a rollback plan", facts: [{ subject: "Status", value: "Agreed" }] }, reason: "The meeting made a decision.", evidence: said },
      ],
    }));
    blockDecisions(svc);
    try {
      writeIntoBrain(svc, rel, meetingCapture("Granola: Orion rollback plan", [`[0:05] Alex: ${said}.`]));
      // The update is dropped, as its note does not exist yet; the note is written; the decision fails, and the run waits to be tried again.
      await failedOnce();
      expect(brainFile(svc, note)).toContain("Drafted");
      unblockDecisions(svc);
      const job = await consolidated(svc, rel);
      // Tried again, the update gets the verdict it got the first time, though its note now exists.
      expect(job.result).toMatchObject({ capture: rel, written: 2, proposals: 0 });
      const { dropped } = job.result as { dropped: string[] };
      expect(dropped).toHaveLength(1);
      expect(dropped[0]).toContain(`${note} does not exist`);
    } finally {
      unblockDecisions(svc);
      stop();
    }
    expect(brainFile(svc, note)).not.toContain("Tove");
    expect(brainFile(svc, `${DECISIONS}/orion-keeps-a-rollback-plan.md`)).toContain("Agreed");
  });

  it("reports a change an earlier attempt dropped once, after it is tried again", async () => {
    const dropped = await droppedNoteThenFailed("2026-11-14-granola-dropped", "Orion release branch");
    expect(dropped.filter((d) => d.includes(`${NOTES}/orion-release-branch.md`))).toHaveLength(1);
  });
});

/** The job once it has run again after `first` and finished. */
const ranAgain = (first: JobView) => until(async () => (await captureJobs(svc)).find((j) => j.id === first.id && j.attempts > first.attempts && finished(j)));

describe("Consolidation that makes Proposals, run again after Attache stopped", () => {
  it("counts the Proposals it made, drops none of them as repeats, and makes none twice", async () => {
    const rel = "evidence/captures/2026-11-16-granola-proposals-restart.md";
    await consolidationWrites(svc, false);
    const stop = meetingWithTwoChanges(rel, "Mette", "Orion keeps weekly releases");
    try {
      const first = await consolidated(svc, rel);
      expect(first.result).toMatchObject({ capture: rel, written: 0, proposals: 2, dropped: [] });
      svc = await diedBeforeTheJobFinished(svc, first.id);
      const again = await ranAgain(first);
      expect(again).toMatchObject({ status: "succeeded", result: { capture: rel, written: 0, proposals: 2, dropped: [] } });
    } finally {
      stop();
      await consolidationWrites(svc, true);
    }
    expect((await consolidationProposals(svc, rel)).map((p) => p.status)).toEqual(["proposed", "proposed"]);
    expect(brainFile(svc, ORION)).not.toContain("Mette");
  });
});

describe("Consolidation run again after the Consolidation switch changed", () => {
  const meeting = (rel: string, subject: string, value: string) => {
    const said = `We decided the Orion ${subject.toLowerCase()} is ${value}`;
    const stop = consolidationReplies(model, () => ({ proposals: [{ item: { action: "update", path: ORION, facts: [{ subject, value }] }, reason: `The meeting set the ${subject}.`, evidence: said }] }));
    writeIntoBrain(svc, rel, meetingCapture(`Granola: Orion ${subject}`, [`[0:05] Alex: ${said}.`]));
    return stop;
  };

  it("a run that made its Proposal, run again with the switch on, finishes and writes nothing twice", async () => {
    const rel = "evidence/captures/2026-11-13-granola-switched-on.md";
    await consolidationWrites(svc, false);
    const stop = meeting(rel, "Freeze owner", "Signe");
    try {
      const first = await consolidated(svc, rel);
      expect(first.result).toMatchObject({ capture: rel, written: 0, proposals: 1 });
      await consolidationWrites(svc, true);
      svc = await diedBeforeTheJobFinished(svc, first.id);
      const again = await ranAgain(first);
      // The run's result counts the Proposal its first attempt made, and does not drop it as a repeat.
      expect(again).toMatchObject({ status: "succeeded", result: { capture: rel, written: 0, proposals: 1, dropped: [] } });
    } finally {
      stop();
      await consolidationWrites(svc, true);
    }
    expect(brainFile(svc, ORION)).not.toContain("Signe");
    expect((await consolidationProposals(svc, rel)).map((p) => p.status)).toEqual(["proposed"]);
  });

  it("a run that made a Proposal for each of two values of a fact, run again with the switch on, drops neither and writes neither", async () => {
    const rel = "evidence/captures/2026-11-17-granola-two-values-switched-on.md";
    const said = "Kasper runs the Orion standup, Kasper Lund from the platform team";
    const value = (v: string) => ({ item: { action: "update", path: ORION, facts: [{ subject: "Standup host", value: v }] }, reason: "The meeting named the standup host.", evidence: said });
    await consolidationWrites(svc, false);
    const stop = consolidationReplies(model, () => ({ proposals: [value("Kasper"), value("Kasper Lund")] }));
    try {
      writeIntoBrain(svc, rel, meetingCapture("Granola: Orion standup", [`[0:05] Alex: ${said}.`]));
      // With the switch off, the owner chooses between the two values: each is its own Proposal.
      const first = await consolidated(svc, rel);
      expect(first.result).toMatchObject({ capture: rel, written: 0, proposals: 2, dropped: [] });
      await consolidationWrites(svc, true);
      svc = await diedBeforeTheJobFinished(svc, first.id);
      const again = await ranAgain(first);
      // Both Proposals are this run's own work, so neither is dropped for the other's value.
      expect(again).toMatchObject({ status: "succeeded", result: { capture: rel, written: 0, proposals: 2, dropped: [] } });
    } finally {
      stop();
      await consolidationWrites(svc, true);
    }
    expect((await consolidationProposals(svc, rel)).map((p) => p.status)).toEqual(["proposed", "proposed"]);
    expect(brainFile(svc, ORION)).not.toContain("Standup host");
  });

  it("a run that wrote its change, run again with the switch off, finishes and makes no Proposal for it", async () => {
    const rel = "evidence/captures/2026-11-13-granola-switched-off.md";
    const stop = meeting(rel, "Test lead", "Birgit");
    try {
      const first = await consolidated(svc, rel);
      expect(first.result).toMatchObject({ capture: rel, written: 1, proposals: 0 });
      await consolidationWrites(svc, false);
      svc = await diedBeforeTheJobFinished(svc, first.id);
      const again = await ranAgain(first);
      // The run's result counts the change its first attempt wrote, and does not drop it as a repeat.
      expect(again).toMatchObject({ status: "succeeded", result: { capture: rel, written: 1, proposals: 0, dropped: [] } });
    } finally {
      stop();
      await consolidationWrites(svc, true);
    }
    expect(brainFile(svc, ORION).match(/\*\*Test lead\*\* \([^)]*\): Birgit/g)).toHaveLength(1);
    expect(await consolidationProposals(svc, rel)).toEqual([]);
  });
});
