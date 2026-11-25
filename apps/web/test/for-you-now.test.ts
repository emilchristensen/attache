import { describe, expect, it } from "vitest";
import type { AttentionItemView, BriefingView } from "@attache/contracts";
import { curateForYouNow, FOR_YOU_NOW_LIMIT, holdEntries, MEETING_LEAD_MS, REPLY_DUE_SOON_MS, REPLY_WORKING_DAY_MS } from "../src/for-you-now.ts";

const CPH = "Europe/Copenhagen";
const NOW = "2026-11-18T09:00:00Z";

function item(id: string, over: Partial<AttentionItemView> = {}): AttentionItemView {
  return {
    id,
    key: `key:${id}`,
    kind: "pending_reply",
    title: `Reply to ${id}`,
    summary: "",
    why: null,
    sourceKind: "gmail",
    connectionId: "gmail",
    url: null,
    dueAt: null,
    priority: 50,
    state: "open",
    snoozeUntil: null,
    startedAt: null,
    evidence: [],
    firstSeenAt: "2026-11-18T08:00:00Z",
    updatedAt: "2026-11-18T08:00:00Z",
    actionId: null,
    actionStatus: null,
    changedSinceDecision: false,
    draftable: null,
    meeting: null,
    ...over,
  };
}

function prep(id: string, start = "2026-11-18T09:12:00Z", over: Partial<AttentionItemView> = {}): AttentionItemView {
  return item(id, {
    kind: "meeting_prep",
    title: `Prepare for ${id}`,
    sourceKind: "gcal",
    connectionId: "gcal",
    dueAt: start,
    meeting: { start, end: "2026-11-18T10:00:00Z", meetLink: null, attendees: [] },
    ...over,
  });
}

function briefing(topPicks: string[] = [], over: Partial<BriefingView> = {}): BriefingView {
  return { ...dailyBriefing(topPicks), ...over };
}

function dailyBriefing(topPicks: string[]): BriefingView {
  return { id: "b1", kind: "daily", createdAt: "2026-11-18T07:00:00Z", since: null, summary: "", sections: [], lead: null, topPicks, updates: [], coverage: [], counts: { open: 0, new: 0, changed: 0, drafts: 0, proposals: 0, failedSources: 0 }, deliverablePath: null };
}

const decide = (items: AttentionItemView[], over: Partial<Parameters<typeof curateForYouNow>[0]> = {}) => curateForYouNow({ items, briefing: null, now: Date.parse(NOW), timeZone: CPH, ...over });

describe("For you now reasons", () => {
  it("applies and ends meeting prep at the named 15-minute window, unless prep was started", () => {
    expect(MEETING_LEAD_MS).toBe(15 * 60_000);
    expect(decide([prep("near")]).entries.map((e) => [e.item.id, e.reason])).toEqual([["near", "meeting-prep"]]);
    expect(decide([prep("far", "2026-11-18T09:16:00Z")]).entries).toEqual([]);
    expect(decide([prep("started", undefined, { startedAt: "2026-11-18T08:50:00Z" })], { briefing: briefing(["started"]) }).entries).toEqual([]);
    expect(decide([prep("ended", "2026-11-18T08:30:00Z", { meeting: { start: "2026-11-18T08:30:00Z", end: "2026-11-18T09:00:00Z", meetLink: null, attendees: [] } })]).entries).toEqual([]);
  });

  it("applies and ends nearly-late replies by working days or due time", () => {
    expect(REPLY_WORKING_DAY_MS).toBe(24 * 60 * 60_000);
    expect(REPLY_DUE_SOON_MS).toBe(2 * 60 * 60_000);
    expect(decide([item("waited", { firstSeenAt: "2026-11-17T09:00:00Z" })]).entries[0]?.reason).toBe("reply-nearly-late");
    expect(decide([item("due", { dueAt: "2026-11-18T10:30:00Z" })]).entries[0]?.reason).toBe("reply-nearly-late");
    expect(decide([item("fresh", { firstSeenAt: "2026-11-17T09:00:01Z" })]).entries).toEqual([]);
    expect(decide([item("done", { firstSeenAt: "2026-11-17T08:00:00Z", state: "resolved" })]).entries).toEqual([]);
  });

  it("counts only Monday-Friday toward one working day across a weekend", () => {
    const monday = Date.parse("2026-11-23T09:00:00Z");
    expect(decide([item("weekend", { firstSeenAt: "2026-11-20T09:00:00Z" })], { now: monday }).entries[0]?.reason).toBe("reply-nearly-late");
    expect(decide([item("weekend-short", { firstSeenAt: "2026-11-20T09:00:01Z" })], { now: monday }).entries).toEqual([]);
    expect(decide([item("friday-partial", { firstSeenAt: "2026-11-20T15:00:00Z" })], { now: monday }).entries).toEqual([]);
  });

  it("uses the browser time zone for due today and its end", () => {
    const due = item("deadline", { kind: "deadline", dueAt: "2026-11-18T20:30:00Z" });
    expect(decide([due], { now: Date.parse("2026-11-18T09:00:00Z"), timeZone: CPH }).entries[0]?.reason).toBe("due-today");
    expect(decide([due], { now: Date.parse("2026-11-18T21:00:00Z"), timeZone: "America/New_York" }).entries[0]?.reason).toBe("due-today");
    expect(decide([due], { now: Date.parse("2026-11-19T00:00:00Z"), timeZone: CPH }).entries).toEqual([]);
  });

  it("applies a daily briefing pick while it remains open and the briefing is today's latest", () => {
    const picked = item("picked");
    expect(decide([picked], { briefing: briefing([picked.id]) }).entries[0]?.reason).toBe("picked-this-morning");
    // A Daily Briefing prepared in the afternoon is still today's, not this morning's.
    const afternoon = briefing([picked.id], { createdAt: "2026-11-18T13:30:00Z" });
    expect(decide([picked], { briefing: afternoon, now: Date.parse("2026-11-18T14:00:00Z") }).entries[0]?.reasonText).toBe("Picked in today’s Daily Briefing");
    expect(decide([picked], { briefing: briefing([]) }).entries).toEqual([]);
    expect(decide([{ ...picked, state: "snoozed" }], { briefing: briefing([picked.id]) }).entries).toEqual([]);
  });

  it.each<[string, Partial<BriefingView>]>([
    ["an away summary", { kind: "away" }],
    ["a briefing the owner asked for", { kind: "manual" }],
    ["yesterday's Daily Briefing", { createdAt: "2026-11-17T07:00:00Z" }],
  ])("never picks from %s", (_, over) => {
    const picked = item("picked");
    expect(decide([picked], { briefing: briefing([picked.id], over) }).entries).toEqual([]);
  });

  it.each<[string, Partial<AttentionItemView>, string]>([
    ["a review request", { kind: "review_request", title: "Review checkout retry" }, "Due in 45 min"],
    ["a deadline", { kind: "deadline", title: "Send the invoice" }, "Due in 45 min"],
    ["a reply", {}, "Due in 45 min"],
  ])("lists %s within 2 hours of its due time as nearly late", (_, over, text) => {
    const entry = decide([item("soon", { ...over, dueAt: "2026-11-18T09:45:00Z" })]).entries[0];
    expect([entry?.reason, entry?.reasonText]).toEqual(["reply-nearly-late", text]);
  });

  it.each<[string, string, string, string | null]>([
    ["the evening before, in Copenhagen", "2026-11-17T22:30:00Z", CPH, null],
    ["the afternoon before, in New York", "2026-11-17T22:30:00Z", "America/New_York", null],
    ["on the day, in Copenhagen", "2026-11-18T09:00:00Z", CPH, "due-today"],
    ["late on the day, in New York", "2026-11-19T03:30:00Z", "America/New_York", "due-today"],
    ["the morning after, in Copenhagen", "2026-11-18T23:30:00Z", CPH, null],
  ])("treats a date-only due value as a local date, never due soon: %s", (_, now, timeZone, reason) => {
    const entries = decide([item("dated", { kind: "deadline", dueAt: "2026-11-18" })], { now: Date.parse(now), timeZone }).entries;
    expect(entries.map((e) => e.reason)).toEqual(reason ? [reason] : []);
  });

  it("says how many hours are left when more than one", () => {
    expect(decide([item("soon", { dueAt: "2026-11-18T10:30:00Z" })]).entries[0]?.reasonText).toBe("Due in 2 hours");
  });

  it.each<[string, Partial<AttentionItemView>, string]>([
    ["names who has waited", { title: "Reply to Nora Lind: Pilot scope" }, "Nora Lind has waited since Tuesday"],
    ["says it has waited when no one is named", { title: "Reply to the pilot thread" }, "Waiting since Tuesday"],
  ])("%s since the day the reply came", (_, over, text) => {
    expect(decide([item("waited", { ...over, firstSeenAt: "2026-11-17T08:00:00Z" })]).entries[0]?.reasonText).toBe(text);
  });

  it.each<[string, string, string]>([
    ["2026-11-18T09:12:00Z", "Starts in 12 min, prep not read", "before"],
    ["2026-11-18T08:50:00Z", "Meeting started, prep not read", "during"],
  ])("says when a meeting at %s starts: %s (%s)", (start, text) => {
    expect(decide([prep("handover", start)]).entries[0]?.reasonText).toBe(text);
  });
});

describe("For you now curation", () => {
  it("keeps one entry under the most urgent reason in Inbox order within each reason", () => {
    const pickedMeeting = prep("m");
    const near = item("reply", { dueAt: "2026-11-18T10:00:00Z" });
    const today = item("today", { kind: "deadline", dueAt: "2026-11-18T16:00:00Z" });
    const picked = item("picked");
    const entries = decide([today, picked, near, pickedMeeting], { briefing: briefing([picked.id, pickedMeeting.id]) }).entries;
    expect(entries.map((e) => [e.item.id, e.reason])).toEqual([
      ["m", "meeting-prep"],
      ["reply", "reply-nearly-late"],
      ["today", "due-today"],
      ["picked", "picked-this-morning"],
    ]);
  });

  it("shows at most the named limit and reports the Inbox remainder", () => {
    expect(FOR_YOU_NOW_LIMIT).toBe(5);
    const items = Array.from({ length: 8 }, (_, n) => item(String(n)));
    const result = decide(items, { briefing: briefing(items.map((i) => i.id)) });
    expect(result.entries.map((e) => e.item.id)).toEqual(["0", "1", "2", "3", "4"]);
    expect(result.moreInInbox).toBe(3);
  });

  it("says what comes next when no reason applies", () => {
    expect(decide([], { now: Date.parse("2026-11-18T08:00:00Z") }).quiet).toBe("Nothing right now.");
    expect(decide([prep("next", "2026-11-18T09:20:00Z")], { now: Date.parse("2026-11-18T09:00:00Z") }).quiet).toBe("Nothing right now. Next: prep for next at 10:20");
  });

  it("holds membership and order while held, with each entry's current item and reason, and no words for a reason that ended", () => {
    const reply = item("reply", { dueAt: "2026-11-18T10:30:00Z" });
    const meeting = prep("meeting");
    const held = decide([reply, meeting]);
    expect(held.entries.map((e) => e.item.id)).toEqual(["meeting", "reply"]);
    // Prep started (its reason has ended), the reply's due time moved closer, and a new item became timely.
    const started = { ...meeting, startedAt: "2026-11-18T09:00:00Z" };
    const sooner = { ...reply, dueAt: "2026-11-18T09:45:00Z" };
    const arrived = item("arrived", { dueAt: "2026-11-18T09:30:00Z" });
    const items = [arrived, sooner, started];
    const shown = holdEntries(held, decide(items), items);
    // The started prep keeps its place, but not "prep not read" beside its In progress: its row's own source line shows.
    expect(shown.entries.map((e) => [e.item.id, e.reasonText])).toEqual([
      ["meeting", null],
      ["reply", "Due in 45 min"],
    ]);
    expect(shown.entries[0]!.item.startedAt).toBe("2026-11-18T09:00:00Z");
    expect(shown.moreInInbox).toBe(held.moreInInbox);
  });

  it("keeps an item's last data while held once it has left the Inbox", () => {
    const reply = item("reply", { dueAt: "2026-11-18T10:30:00Z" });
    const held = decide([reply]);
    expect(holdEntries(held, decide([]), []).entries).toEqual(held.entries);
  });

  it("says tomorrow when the next prep is not today", () => {
    const tomorrow = prep("standup", "2026-11-19T08:00:00Z", { meeting: { start: "2026-11-19T08:00:00Z", end: "2026-11-19T08:30:00Z", meetLink: null, attendees: [] } });
    expect(decide([tomorrow]).quiet).toBe("Nothing right now. Next: prep for standup tomorrow at 09:00");
  });
});
