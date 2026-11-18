import { describe, expect, it } from "vitest";
import type { JobEvent, JobView } from "@attache/contracts";
import { cancelNote, describeEvent, reasonBeyondSummary, eventTime, initialJobId, JOB_KIND_WORDS, jobSummary, jobTime, runningOrder } from "../src/jobs.ts";

/** A job as `/jobs` returns it, with only what a case sets. */
function job(over: Partial<JobView> = {}): JobView {
  return {
    id: "j1",
    kind: "research",
    title: "Research: What is open on Atlas?",
    status: "succeeded",
    progress: 1,
    progressNote: null,
    attempts: 1,
    maxAttempts: 3,
    result: null,
    error: null,
    createdAt: "2026-11-18T09:00:00.000Z",
    updatedAt: "2026-11-18T09:01:00.000Z",
    startedAt: "2026-11-18T09:00:01.000Z",
    finishedAt: "2026-11-18T09:01:00.000Z",
    cancelRequestedAt: null,
    cancelOutcome: null,
    capability: null,
    connectionId: null,
    ...over,
  };
}

describe("initialJobId: the job the detail pane opens on, chosen once", () => {
  it("takes the running job over a newer queued one and any finished one", () => {
    const running = [job({ id: "queued", status: "queued", createdAt: "2026-11-18T10:05:00.000Z" }), job({ id: "running", status: "running", createdAt: "2026-11-18T10:00:00.000Z" })];
    const finished = [job({ id: "failed", status: "failed", createdAt: "2026-11-18T10:10:00.000Z" })];
    expect(initialJobId(running, finished)).toBe("running");
  });

  it("takes the newest failed or blocked job when nothing runs", () => {
    const finished = [
      job({ id: "newest-ok", createdAt: "2026-11-18T10:30:00.000Z" }),
      job({ id: "blocked", status: "blocked", createdAt: "2026-11-18T10:20:00.000Z" }),
      job({ id: "failed", status: "failed", createdAt: "2026-11-18T10:10:00.000Z" }),
    ];
    expect(initialJobId([], finished)).toBe("blocked");
  });

  it("takes the newest job when nothing runs or failed, a queued one included", () => {
    const queued = [job({ id: "queued", status: "queued", createdAt: "2026-11-18T10:40:00.000Z" })];
    const finished = [job({ id: "ok", createdAt: "2026-11-18T10:30:00.000Z" }), job({ id: "stopped", status: "cancelled", createdAt: "2026-11-18T10:35:00.000Z" })];
    expect(initialJobId(queued, finished)).toBe("queued");
    expect(initialJobId([], finished)).toBe("stopped");
  });

  it("judges a job found twice by its newest state, so a failure that was retried meanwhile does not win", () => {
    const retried = job({ id: "retried", status: "failed", createdAt: "2026-11-18T10:30:00.000Z", updatedAt: "2026-11-18T10:31:00.000Z" });
    const now = { ...retried, status: "succeeded" as const, updatedAt: "2026-11-18T10:32:00.000Z" };
    const stillFailed = job({ id: "still", status: "failed", createdAt: "2026-11-18T10:00:00.000Z" });
    expect(initialJobId([], [now, stillFailed, retried])).toBe("still");
    expect(initialJobId([], [retried, stillFailed, now])).toBe("still");
  });

  it("is null when there are no jobs", () => {
    expect(initialJobId([], [])).toBeNull();
  });
});

describe("runningOrder: the Running group", () => {
  it("lists running work first, newest first, then queued work in the order it will start", () => {
    const rows = [
      job({ id: "q-late", status: "queued", createdAt: "2026-11-18T10:20:00.000Z" }),
      job({ id: "r-old", status: "running", createdAt: "2026-11-18T10:00:00.000Z" }),
      job({ id: "q-early", status: "queued", createdAt: "2026-11-18T10:10:00.000Z" }),
      job({ id: "r-new", status: "running", createdAt: "2026-11-18T10:05:00.000Z" }),
    ];
    expect(runningOrder(rows).map((j) => j.id)).toEqual(["r-new", "r-old", "q-early", "q-late"]);
  });
});

describe("jobSummary: a row's result in a few words", () => {
  it.each<[string, Partial<JobView>, { tag: string | null; words: string }]>([
    ["running, with its progress note", { status: "running", progress: 0.4, progressNote: "Composing briefing" }, { tag: null, words: "40% · Composing briefing" }],
    ["running, no note yet", { status: "running", progress: 0, progressNote: null }, { tag: null, words: "0%" }],
    ["queued", { status: "queued", attempts: 0 }, { tag: null, words: "Waiting to start" }],
    ["queued again after a failed attempt", { status: "queued", attempts: 1, error: "fetch failed" }, { tag: null, words: "Trying again after: fetch failed" }],
    ["research with sources", { kind: "research", result: { relPath: "deliverables/research/x.md", citations: [{}, {}], supported: true } }, { tag: null, words: "Answered from 2 sources" }],
    ["research nothing supports", { kind: "research", result: { relPath: "deliverables/research/x.md", citations: [], supported: false } }, { tag: null, words: "No supporting evidence found" }],
    ["briefing", { kind: "briefing", result: { briefingId: "b1", relPath: "x.md" } }, { tag: null, words: "Briefing written" }],
    ["draft", { kind: "draft", result: { actionId: "a1", version: 2 } }, { tag: null, words: "Draft v2 ready" }],
    ["source refresh", { kind: "source-refresh", result: { sources: [{ id: "github", created: 2 }, { id: "gmail", created: 1 }] } }, { tag: null, words: "Read 2 sources · 3 new items" }],
    ["source refresh, nothing new", { kind: "source-refresh", result: { sources: [{ id: "github", created: 0 }] } }, { tag: null, words: "Read 1 source · nothing new" }],
    ["reindex", { kind: "reindex", result: { indexed: 41 } }, { tag: null, words: "Indexed 41 files" }],
    ["sent", { kind: "action", result: { status: "succeeded" } }, { tag: null, words: "Sent" }],
    ["send failed", { kind: "action", result: { status: "failed", error: "403" } }, { tag: null, words: "Not sent" }],
    ["send unknown", { kind: "action", result: { status: "unknown" } }, { tag: null, words: "Outcome unknown" }],
    ["diagnostics", { kind: "demo-long", result: { completedSteps: 60 } }, { tag: null, words: "60 steps done" }],
    ["any other kind", { kind: "session-distill", result: { saved: 1 } }, { tag: null, words: "Done" }],
    ["finished before the cancel", { kind: "briefing", cancelOutcome: "too_late", result: {} }, { tag: null, words: "Finished before the cancel" }],
    ["failed, with its reason", { status: "failed", error: "Model not configured.\nSee Settings." }, { tag: "Failed", words: "Model not configured." }],
    ["failed, no reason", { status: "failed", error: null }, { tag: "Failed", words: "No reason was recorded" }],
    ["blocked, with its reason", { status: "blocked", error: "Attention is switched off" }, { tag: "Blocked", words: "Attention is switched off" }],
    ["cancelled before it started", { status: "cancelled", cancelOutcome: "not_started" }, { tag: null, words: "Cancelled before it started" }],
    ["cancelled while running", { status: "cancelled", cancelOutcome: "stopped" }, { tag: null, words: "Cancelled, stopped early" }],
  ])("%s", (_case, over, expected) => {
    expect(jobSummary(job(over))).toEqual(expected);
  });
});

describe("jobTime: the narrow time column", () => {
  const now = Date.parse("2026-11-18T14:00:00.000Z");
  const zone = "Europe/Copenhagen";
  it.each<[string, Partial<JobView>, { text: string; label: string; iso: string }]>([
    ["finished today: the clock time", { finishedAt: "2026-11-18T08:15:00.000Z" }, { text: "09:15", label: "Finished at 09:15", iso: "2026-11-18T08:15:00.000Z" }],
    ["finished yesterday", { finishedAt: "2026-11-17T21:30:00.000Z" }, { text: "Yesterday", label: "Finished yesterday at 22:30", iso: "2026-11-17T21:30:00.000Z" }],
    ["finished earlier", { finishedAt: "2026-11-02T10:00:00.000Z" }, { text: "2 Nov", label: "Finished on 2 November at 11:00", iso: "2026-11-02T10:00:00.000Z" }],
    ["running: when it started", { status: "running", startedAt: "2026-11-18T13:58:00.000Z", finishedAt: null }, { text: "14:58", label: "Started at 14:58", iso: "2026-11-18T13:58:00.000Z" }],
    ["queued: when it was asked for", { status: "queued", createdAt: "2026-11-18T13:59:00.000Z", startedAt: null, finishedAt: null }, { text: "14:59", label: "Queued at 14:59", iso: "2026-11-18T13:59:00.000Z" }],
    ["ended with no finish time: its last change", { status: "blocked", finishedAt: null, updatedAt: "2026-11-18T12:00:00.000Z" }, { text: "13:00", label: "Ended at 13:00", iso: "2026-11-18T12:00:00.000Z" }],
  ])("%s", (_case, over, expected) => {
    expect(jobTime(job(over), now, zone)).toEqual(expected);
  });
});

describe("cancelNote: what Cancel reports", () => {
  it.each<[string, Partial<JobView>, string | null]>([
    ["nothing asked", { status: "running" }, null],
    ["asked, the work still stopping", { status: "running", cancelRequestedAt: "2026-11-18T10:00:00.000Z" }, "Cancel asked for. Waiting for the work to stop…"],
    ["the work stopped", { status: "cancelled", cancelRequestedAt: "2026-11-18T10:00:00.000Z", cancelOutcome: "stopped" }, "Stopped: the work ended before it finished."],
    ["it had already finished", { status: "succeeded", cancelRequestedAt: "2026-11-18T10:00:00.000Z", cancelOutcome: "too_late" }, "Already finished: the cancel came after the work was done, so its result stands."],
    ["it had not started", { status: "cancelled", cancelOutcome: "not_started" }, "Cancelled before it started."],
    ["a failure with an old request but no outcome says nothing about stopping", { status: "failed", cancelRequestedAt: "2026-11-18T10:00:00.000Z" }, null],
  ])("%s", (_case, over, expected) => {
    expect(cancelNote(job(over))).toBe(expected);
  });

  it("says a job was already cancelled when this request found it stopped by an earlier one", () => {
    const stopped = job({ status: "cancelled", cancelRequestedAt: "2026-11-18T10:00:00.000Z", cancelOutcome: "stopped" });
    expect(cancelNote(stopped, "too_late")).toBe("Already cancelled: the work had stopped before this request.");
    expect(cancelNote(stopped, "stopped")).toBe("Stopped: the work ended before it finished.");
    expect(cancelNote(job({ status: "succeeded", cancelOutcome: "too_late" }), "too_late")).toBe("Already finished: the cancel came after the work was done, so its result stands.");
  });
});

describe("describeEvent: one line of a job's events", () => {
  const event = (type: string, data: Record<string, unknown> = {}): JobEvent => ({ seq: 1, jobId: "j1", type, data, at: "2026-11-18T10:00:00.000Z" });
  it.each<[JobEvent, string]>([
    [event("progress", { progress: 0.25, note: "Step 15 of 60" }), "25% · Step 15 of 60"],
    [event("searched", { query: "Orion", hits: 1 }), "Searched “Orion”: 1 hit"],
    [event("source_synced", { id: "github", coverage: "complete" }), "Refreshed github: complete"],
    [event("retry_scheduled", { error: "fetch failed", inMs: 4000 }), "Failed (fetch failed); trying again in 4 s"],
    [event("failed", { error: "boom" }), "Failed: boom"],
    [event("blocked", { reason: "Attention is switched off" }), "Blocked: Attention is switched off"],
    [event("cancelled", { outcome: "stopped" }), "Stopped: the work ended before it finished."],
    [event("cancel_too_late", { status: "succeeded" }), "Already finished: the cancel came after the work was done, so its result stands."],
    [event("cancel_requested"), "Cancel asked for"],
    [event("queued"), "Queued"],
    [event("started", { attempt: 1 }), "Started"],
    [event("started", { attempt: 2 }), "Started attempt 2"],
    [event("succeeded"), "Finished"],
    [event("retry_requested"), "Retry asked for"],
    [event("model_unavailable"), "Model unavailable"],
  ])("%j", (e, expected) => {
    expect(describeEvent(e)).toBe(expected);
  });
});

describe("JOB_KIND_WORDS", () => {
  it("names every kind the service runs", () => {
    expect(JOB_KIND_WORDS["source-refresh"]).toBe("Source refresh");
    expect(JOB_KIND_WORDS["demo-long"]).toBe("Diagnostics");
  });
});

describe("eventTime: an event's time in the 76 px timeline column", () => {
  const now = Date.parse("2026-11-18T14:00:00.000Z");
  it.each<[string, string, string]>([
    ["today, to the second", "2026-11-18T08:15:02.000Z", "09:15:02"],
    ["another day, the day", "2026-11-17T08:15:02.000Z", "17 Nov"],
  ])("%s", (_case, iso, expected) => {
    expect(eventTime(iso, now, "Europe/Copenhagen")).toBe(expected);
  });
});

describe("reasonBeyondSummary: the full reason, only when the row's few words leave some out", () => {
  it.each<[string, Partial<JobView>, string | null]>([
    ["one line: the summary already says it", { status: "blocked", error: "The attention item no longer exists" }, null],
    ["several lines: all of them", { status: "failed", error: "Model not configured.\nSee Settings > Model." }, "Model not configured.\nSee Settings > Model."],
    ["a success has none", { status: "succeeded", error: "old" }, null],
  ])("%s", (_case, over, expected) => {
    expect(reasonBeyondSummary(job(over))).toBe(expected);
  });
});
