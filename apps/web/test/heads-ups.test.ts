import { describe, expect, it } from "vitest";
import type { AttentionItemView } from "@attache/contracts";
import { forYouNow, heldSlot, HEADS_UP_KINDS, MEETING_LEAD_MS, promotedMeetings, withArrivedMeetings, RANK, VISIBLE_FOLLOWERS, type BriefingView, type HeadsUp, type HeadsUpInput, type HeadsUpKind } from "../src/heads-ups.ts";

const CPH = "Europe/Copenhagen";

/** A briefing as `GET /briefings/latest` returns it. */
function briefing(over: Partial<BriefingView> = {}): BriefingView {
  return {
    id: "b1",
    kind: "daily",
    createdAt: "2026-11-18T07:02:00Z", // 08:02 in Copenhagen
    since: null,
    summary: "Nora confirmed the pilot window. The invoice fallback still needs your review. A reply to Nora is ready.",
    sections: [],
    counts: { open: 4, new: 1, changed: 0, drafts: 1, proposals: 0, failedSources: 0 },
    deliverablePath: "deliverables/briefings/2026-11-18.md",
    ...over,
  };
}

function input(at: string, over: Partial<HeadsUpInput> = {}): HeadsUpInput {
  return { now: Date.parse(at), timeZone: CPH, briefing: briefing(), briefingJob: null, settled: new Set(), schedule: { enabled: true, nextRunAt: "2026-11-19T07:00:00Z" }, meetings: [], ...over };
}

describe("the daily briefing", () => {
  it("leads from when it is written until local noon", () => {
    const slot = forYouNow(input("2026-11-18T09:30:00Z")); // 10:30 in Copenhagen
    expect(slot.lead).toMatchObject({ key: "briefing:b1", kind: "daily-briefing", label: "Morning briefing", timing: "Until noon", title: "Nora confirmed the pilot window.", explanation: "The invoice fallback still needs your review." });
    expect(slot.followers).toEqual([]);
    expect(slot.quiet).toBeNull();
  });
});

describe("the daily briefing after noon or Got it", () => {
  it("shrinks to an Earlier today line at noon", () => {
    const slot = forYouNow(input("2026-11-18T11:00:00Z")); // 12:00 in Copenhagen
    expect(slot.lead).toBeNull();
    expect(slot.followers).toMatchObject([{ key: "earlier:b1", kind: "earlier-today", form: "line", label: "Daily briefing", timing: "Earlier today, 08:02" }]);
    expect(slot.followers[0]!.why).toBe("Written at 08:02. It stays here until midnight while it is the latest briefing.");
  });

  it("still leads one minute before noon", () => {
    expect(forYouNow(input("2026-11-18T10:59:00Z")).lead?.kind).toBe("daily-briefing");
  });

  it("shrinks to the Earlier today line on Got it, before noon", () => {
    const slot = forYouNow(input("2026-11-18T08:00:00Z", { settled: new Set(["briefing:b1"]) }));
    expect(slot.lead).toBeNull();
    expect(slot.followers.map((h) => h.kind)).toEqual(["earlier-today"]);
  });

  it("leaves at midnight", () => {
    expect(forYouNow(input("2026-11-18T22:59:00Z")).followers.map((h) => h.kind)).toEqual(["earlier-today"]);
    const next = forYouNow(input("2026-11-18T23:00:00Z")); // 00:00 on the 19th in Copenhagen
    expect(next.lead).toBeNull();
    expect(next.followers).toEqual([]);
  });

  it("never shows yesterday's briefing as today's", () => {
    const slot = forYouNow(input("2026-11-19T07:30:00Z")); // 08:30 the next morning, before the new one is written
    expect(slot.lead).toBeNull();
    expect(slot.followers).toEqual([]);
  });

  it("goes straight to the Earlier today line when it is written after noon", () => {
    const late = briefing({ createdAt: "2026-11-18T13:15:00Z" }); // 14:15 in Copenhagen, a catch-up
    const slot = forYouNow(input("2026-11-18T13:20:00Z", { briefing: late }));
    expect(slot.lead).toBeNull();
    expect(slot.followers.map((h) => [h.kind, h.timing])).toEqual([["earlier-today", "Earlier today, 14:15"]]);
  });
});

describe("a time zone change", () => {
  it("counts noon and the day in the zone the browser is in now", () => {
    // Written 08:02 in Copenhagen = 02:02 in New York. At 10:30 Copenhagen time it is 04:30 in New York.
    const there = forYouNow(input("2026-11-18T09:30:00Z", { timeZone: "America/New_York" }));
    expect(there.lead).toMatchObject({ kind: "daily-briefing", why: "Written at 02:02 for this morning. It leaves at noon, or when you press Got it." });
    // At 12:30 Copenhagen time the Copenhagen noon has passed, but in New York it is 06:30: still the morning there.
    expect(forYouNow(input("2026-11-18T11:30:00Z", { timeZone: "America/New_York" })).lead?.kind).toBe("daily-briefing");
    // New York's noon is 17:00 UTC.
    expect(forYouNow(input("2026-11-18T17:00:00Z", { timeZone: "America/New_York" })).followers.map((h) => h.kind)).toEqual(["earlier-today"]);
  });

  it("moves the briefing to the day it falls on in the new zone", () => {
    // Written 08:02 in Copenhagen on the 18th = 18:02 on the 18th in Sydney. Flying on: at 09:00 Sydney on the 19th, it is yesterday's.
    const slot = forYouNow(input("2026-11-18T22:00:00Z", { timeZone: "Australia/Sydney" }));
    expect(slot.lead).toBeNull();
    expect(slot.followers).toEqual([]);
  });

  it("finds noon across a daylight-saving change", () => {
    // Copenhagen leaves summer time at 03:00 on 25 October 2026; that day's noon is 11:00 UTC, not 10:00.
    const autumn = briefing({ createdAt: "2026-10-25T06:00:00Z" });
    expect(forYouNow(input("2026-10-25T10:30:00Z", { briefing: autumn })).lead?.kind).toBe("daily-briefing");
    expect(forYouNow(input("2026-10-25T11:00:00Z", { briefing: autumn })).lead).toBeNull();
  });
});

describe("an away summary and a briefing the owner asked for", () => {
  const away = briefing({ id: "a1", kind: "away", createdAt: "2026-11-18T13:10:00Z", since: "2026-11-15T13:10:00Z" }); // 14:10 in Copenhagen
  const asked = briefing({ id: "m1", kind: "manual", createdAt: "2026-11-18T13:10:00Z" });

  it("leads for four hours from when it was made", () => {
    expect(forYouNow(input("2026-11-18T13:10:00Z", { briefing: away })).lead).toMatchObject({ key: "briefing:a1", kind: "away-summary", label: "Away summary", timing: "Until 18:10", why: "You asked for it at 14:10. It leaves at 18:10, or when you press Got it.", actions: ["read-briefing", "got-it"] });
    expect(forYouNow(input("2026-11-18T17:09:00Z", { briefing: asked })).lead).toMatchObject({ key: "briefing:m1", kind: "requested-briefing", label: "Briefing you asked for", timing: "Until 18:10" });
  });

  it("leaves after four hours, with no line after it", () => {
    for (const b of [away, asked]) {
      const slot = forYouNow(input("2026-11-18T17:10:00Z", { briefing: b }));
      expect(slot.lead).toBeNull();
      expect(slot.followers).toEqual([]);
    }
  });

  it("leaves on Got it", () => {
    expect(forYouNow(input("2026-11-18T14:00:00Z", { briefing: away, settled: new Set(["briefing:a1"]) })).lead).toBeNull();
  });

  it("says which day it was made when that was not today", () => {
    const lateNight = briefing({ id: "m2", kind: "manual", createdAt: "2026-11-18T22:30:00Z" }); // 23:30 in Copenhagen
    expect(forYouNow(input("2026-11-18T23:30:00Z", { briefing: lateNight })).lead).toMatchObject({ timing: "Until 03:30", why: "You asked for it yesterday at 23:30. It leaves at 03:30, or when you press Got it." });
  });

  it("is never the daily briefing's Earlier today line", () => {
    expect(forYouNow(input("2026-11-18T20:00:00Z", { briefing: away })).followers).toEqual([]);
  });
});

describe("briefing progress", () => {
  it("is a line while a briefing job runs, under the briefing", () => {
    const slot = forYouNow(input("2026-11-18T09:30:00Z", { briefingJob: { id: "j1", progress: 0.4, note: "Composing briefing" } }));
    expect(slot.lead?.kind).toBe("daily-briefing");
    expect(slot.followers).toMatchObject([{ key: "progress:j1", kind: "briefing-progress", form: "line", label: "Preparing a briefing", timing: "40%", title: "Composing briefing", why: "Here while the briefing is written. It keeps running if you close this tab." }]);
  });

  it("says Queued before the job reports", () => {
    expect(forYouNow(input("2026-11-18T09:30:00Z", { briefing: null, briefingJob: { id: "j1", progress: 0, note: null } })).followers[0]).toMatchObject({ title: "Queued", timing: "0%" });
  });
});

/** A stand-in kind, as meeting prep will be: one card per meeting, ranked before briefings. */
function meetings(...starts: Array<[key: string, start: string]>): HeadsUpKind {
  return {
    id: "daily-briefing",
    applies: () =>
      starts.map(([key, start]): HeadsUp => ({ key, kind: "daily-briefing", form: "card", rank: RANK.meeting, at: Date.parse(start), label: "Meeting prep", timing: "", title: key, explanation: null, why: "", actions: [] })),
  };
}

describe("the slot", () => {
  it("orders by urgency, then time, then key, with one lead and the rest as followers", () => {
    const kinds = [...HEADS_UP_KINDS, meetings(["m:b", "2026-11-18T09:30:00Z"], ["m:a", "2026-11-18T09:30:00Z"], ["m:early", "2026-11-18T09:00:00Z"])];
    const slot = forYouNow(input("2026-11-18T09:20:00Z", { briefingJob: { id: "j1", progress: 0.5, note: null } }), kinds);
    expect(slot.lead?.key).toBe("m:early");
    expect(VISIBLE_FOLLOWERS).toBe(2);
    expect(slot.followers.map((h) => h.key)).toEqual(["m:a", "m:b"]);
    expect(slot.more.map((h) => h.key)).toEqual(["briefing:b1", "progress:j1"]);
  });

  it("has no lead when the most urgent entry is a line", () => {
    const slot = forYouNow(input("2026-11-18T13:00:00Z", { briefingJob: { id: "j1", progress: 0.5, note: null } }));
    expect(slot.lead).toBeNull();
    expect(slot.followers.map((h) => h.kind)).toEqual(["briefing-progress", "earlier-today"]);
  });

  it("gives every Heads-up a why line", () => {
    const cases = [input("2026-11-18T09:30:00Z"), input("2026-11-18T13:00:00Z"), input("2026-11-18T13:10:00Z", { briefing: briefing({ kind: "away", createdAt: "2026-11-18T13:00:00Z" }) }), input("2026-11-18T13:10:00Z", { briefing: briefing({ kind: "manual", createdAt: "2026-11-18T13:00:00Z" }), briefingJob: { id: "j", progress: 0, note: null } })];
    const shown = cases.flatMap((c) => {
      const s = forYouNow(c);
      return [...(s.lead ? [s.lead] : []), ...s.followers, ...s.more];
    });
    expect(new Set(shown.map((h) => h.kind))).toEqual(new Set(["daily-briefing", "earlier-today", "away-summary", "requested-briefing", "briefing-progress"]));
    for (const h of shown) expect(h.why.length).toBeGreaterThan(20);
  });
});

describe("the quiet line", () => {
  it("says nothing is timely and when the scheduler runs the next daily briefing, in the current zone", () => {
    expect(forYouNow(input("2026-11-19T05:00:00Z", { briefing: null })).quiet).toBe("Nothing timely right now. The daily briefing is scheduled for 08:00.");
    // Yesterday's briefing is the latest, but its day is over.
    expect(forYouNow(input("2026-11-19T05:00:00Z")).quiet).toBe("Nothing timely right now. The daily briefing is scheduled for 08:00.");
    // The Reader schedules at 08:00 Copenhagen time; seen from New York that is 02:00.
    expect(forYouNow(input("2026-11-19T05:00:00Z", { briefing: null, timeZone: "America/New_York" })).quiet).toBe("Nothing timely right now. The daily briefing is scheduled for 02:00.");
  });

  it("says tomorrow, or the day, when the next run is not today", () => {
    expect(forYouNow(input("2026-11-18T21:30:00Z", { briefing: null })).quiet).toBe("Nothing timely right now. The next daily briefing is scheduled for 08:00 tomorrow.");
    expect(forYouNow(input("2026-11-18T21:30:00Z", { briefing: null, schedule: { enabled: true, nextRunAt: "2026-11-21T07:00:00Z" } })).quiet).toBe("Nothing timely right now. The next daily briefing is scheduled on 21 November at 08:00.");
  });

  it("says when daily briefings are off, and makes no promise while the next run is not known or already due", () => {
    expect(forYouNow(input("2026-11-19T05:00:00Z", { briefing: null, schedule: { enabled: false, nextRunAt: null } })).quiet).toBe("Nothing timely right now. The daily briefing is switched off.");
    expect(forYouNow(input("2026-11-19T05:00:00Z", { briefing: null, schedule: null })).quiet).toBe("Nothing timely right now.");
    expect(forYouNow(input("2026-11-19T08:00:00Z", { briefing: null })).quiet).toBe("Nothing timely right now.");
  });

  it("is not shown while the briefing is not known, so it never claims nothing is timely", () => {
    const slot = forYouNow(input("2026-11-19T05:00:00Z", { briefing: "unknown" }));
    expect(slot).toEqual({ lead: null, followers: [], more: [], quiet: null });
  });
});

describe("the lead's development", () => {
  const item = (id: string, title: string, over: object = {}) => ({ id, title, summary: `About ${title}.`, url: null, isNew: false, changed: false, ...over });

  it("leads with a concrete item when the summary only counts, as the no-model summary does", () => {
    const counted = briefing({
      summary: "2 deadlines, 1 review request. 1 new and 0 changed since the last briefing.",
      sections: [
        { id: "deadlines", title: "Deadlines", items: [item("i1", "Overdue: Review rollback runbook")] },
        { id: "reviews", title: "Review queue", items: [item("i2", "Review acme/web#42", { isNew: true })] },
      ],
    });
    expect(forYouNow(input("2026-11-18T09:30:00Z", { briefing: counted })).lead).toMatchObject({ title: "Review acme/web#42", explanation: "About Review acme/web#42." });
    const nothingNew = briefing({ summary: "1 deadline.", sections: [{ id: "deadlines", title: "Deadlines", items: [item("i1", "Overdue: Review rollback runbook")] }] });
    expect(forYouNow(input("2026-11-18T09:30:00Z", { briefing: nothingNew })).lead).toMatchObject({ title: "Overdue: Review rollback runbook" });
  });

  it("leads with the item when the summary opens with no words, as the no-model summary does for Other items alone", () => {
    const other = briefing({ summary: ". 1 new and 0 changed since the last briefing.", sections: [{ id: "other", title: "Other", items: [item("r1", "Replication blocked")] }] });
    expect(forYouNow(input("2026-11-18T09:30:00Z", { briefing: other })).lead).toMatchObject({ title: "Replication blocked", explanation: "About Replication blocked." });
  });

  it("keeps the summary's own first sentence otherwise", () => {
    expect(forYouNow(input("2026-11-18T09:30:00Z", { briefing: briefing({ summary: "Nothing needs your attention right now." }) })).lead).toMatchObject({ title: "Nothing needs your attention right now.", explanation: null });
    expect(forYouNow(input("2026-11-18T09:30:00Z", { briefing: briefing({ summary: "2 deadlines.", sections: [] }) })).lead).toMatchObject({ title: "2 deadlines." });
  });
});

describe("a held slot", () => {
  const asked = briefing({ id: "b2", kind: "manual", createdAt: "2026-11-18T09:31:00Z" });
  const job = { id: "j1", progress: 0.75, note: "Composing briefing" };
  const keys = (slot: ReturnType<typeof forYouNow>) => [slot.lead, ...slot.followers, ...slot.more].map((h) => h?.key ?? null);

  it("holds still: a newer briefing waits, and so do the clock and another tab's Got it", () => {
    const held = input("2026-11-18T09:30:00Z");
    const live = input("2026-11-18T11:30:00Z", { briefing: asked, settled: new Set(["briefing:b1"]) });
    expect(heldSlot(held, live)).toEqual(forYouNow(held));
  });

  it("lets the briefing a progress line was writing take that line's place, as a line, so nothing else moves", () => {
    // Asked for with nothing else timely: the progress line came up under the pointer resting where the menu was.
    const held = input("2026-11-18T09:30:00Z", { briefing: null, briefingJob: job });
    const slot = heldSlot(held, input("2026-11-18T09:31:00Z", { briefing: asked }));
    expect(slot.lead).toBeNull();
    expect(slot.followers).toMatchObject([{ key: "briefing:b2", kind: "requested-briefing", actions: ["read-briefing", "got-it"], inPlaceOf: "progress:j1" }]);
    expect(slot.quiet).toBeNull();
    // The held entries around it stay where they were, the briefing they came from too.
    const beside = heldSlot(input("2026-11-18T09:30:00Z", { briefingJob: job }), input("2026-11-18T09:31:00Z", { briefing: asked }));
    expect(keys(beside)).toEqual(["briefing:b1", "briefing:b2"]);
  });

  it("keeps the progress line while its job runs, or until the briefing it wrote is here", () => {
    const held = input("2026-11-18T09:30:00Z", { briefing: null, briefingJob: job });
    expect(keys(heldSlot(held, input("2026-11-18T09:31:00Z", { briefing: null, briefingJob: { ...job, progress: 0.9 } })))).toEqual([null, "progress:j1"]);
    expect(keys(heldSlot(held, input("2026-11-18T09:31:00Z", { briefing: null })))).toEqual([null, "progress:j1"]);
    // A briefing that came while the job still runs is not the one it writes.
    expect(keys(heldSlot(held, input("2026-11-18T09:31:00Z", { briefing: asked, briefingJob: job })))).toEqual([null, "progress:j1"]);
    // Once it has ended, a later job does not keep it.
    expect(keys(heldSlot(held, input("2026-11-18T09:31:00Z", { briefing: asked, briefingJob: { id: "j2", progress: 0, note: null } })))).toEqual([null, "briefing:b2"]);
  });

  it("shows nothing new until a handoff is given", () => {
    const held = input("2026-11-18T09:30:00Z", { briefing: null, briefingJob: job });
    expect(heldSlot(held, null)).toEqual(forYouNow(held));
  });

  it("never lets a briefing in without a progress line in its place", () => {
    const held = input("2026-11-18T09:30:00Z", { briefing: briefing({ id: "b0", kind: "manual", createdAt: "2026-11-18T09:00:00Z" }) });
    expect(keys(heldSlot(held, input("2026-11-18T09:31:00Z", { briefing: asked })))).toEqual(["briefing:b0"]);
  });

  it("leaves the place empty when the owner put the briefing away here, and says so once nothing is left", () => {
    const held = input("2026-11-18T09:30:00Z", { briefing: null, briefingJob: job, settled: new Set(["briefing:b2"]) });
    const slot = heldSlot(held, input("2026-11-18T09:31:00Z", { briefing: asked }));
    expect(keys(slot)).toEqual([null]);
    expect(slot.quiet).toBe("Nothing timely right now. The next daily briefing is scheduled for 08:00 tomorrow.");
  });
});

/** An open meeting prep item as `GET /attention` returns it. */
function prep(id: string, start: string, end: string, over: Partial<AttentionItemView["meeting"] & object> = {}): AttentionItemView {
  return {
    id,
    key: `gcal:${id}`,
    kind: "meeting_prep",
    title: `Prepare for ${id === "a" ? "Pilot handover" : id === "b" ? "Billing triage" : `Meeting ${id}`}`,
    summary: "Starts soon with Nora Lind.",
    why: "A meeting with other people starts within 24 hours.",
    sourceKind: "gcal",
    connectionId: "gcal",
    url: `https://calendar.google.com/event?eid=${id}`,
    dueAt: start,
    priority: 70,
    state: "open",
    snoozeUntil: null,
    evidence: [],
    firstSeenAt: "2026-11-17T12:00:00Z",
    updatedAt: "2026-11-17T12:00:00Z",
    actionId: null,
    actionStatus: null,
    changedSinceDecision: false,
    draftable: null,
    meeting: { start, end, meetLink: `https://meet.google.com/${id}`, attendees: ["Nora Lind", "Sam Berg"], ...over },
  };
}

// Copenhagen is UTC+1 in November: 09:00Z is 10:00 there.
const handover = prep("a", "2026-11-18T09:00:00Z", "2026-11-18T09:30:00Z");
const triage = prep("b", "2026-11-18T09:30:00Z", "2026-11-18T10:00:00Z");
const all = (slot: ReturnType<typeof forYouNow>) => [slot.lead, ...slot.followers, ...slot.more].filter((h): h is HeadsUp => h !== null);
const keysOf = (slot: ReturnType<typeof forYouNow>) => all(slot).map((h) => h.key);

describe("meeting prep", () => {
  it("is not here more than 15 minutes before the start", () => {
    expect(MEETING_LEAD_MS).toBe(15 * 60_000);
    const slot = forYouNow(input("2026-11-18T08:44:00Z", { briefing: null, meetings: [handover] }));
    expect(all(slot)).toEqual([]);
    // The quiet line says when it comes, as it does for the next daily briefing.
    expect(slot.quiet).toBe("Nothing timely right now. Prep for Pilot handover shows here at 09:45.");
  });

  it("leads from 15 minutes before the start, saying when it starts, with Open prep first", () => {
    const slot = forYouNow(input("2026-11-18T08:45:00Z", { briefing: null, meetings: [handover] }));
    expect(slot.lead).toMatchObject({
      key: "meeting:a",
      kind: "meeting-prep",
      form: "card",
      rank: RANK.meeting,
      label: "Meeting prep",
      timing: "Starts 10:00",
      title: "Pilot handover",
      explanation: "On your calendar",
      actions: ["open-prep", "calendar", "join", "done", "not-now"],
      meeting: { itemId: "a", phase: "upcoming", interval: "10:00 to 10:30", calendarUrl: "https://calendar.google.com/event?eid=a", meetLink: "https://meet.google.com/a", attendees: ["Nora Lind", "Sam Berg"] },
    });
    expect(slot.lead!.why).toBe("A meeting with other people starts at 10:00. It is here from 09:45 until it ends at 10:30, or until Done or Not now.");
  });

  it("reads In progress with Join first from the start until the scheduled end", () => {
    for (const at of ["2026-11-18T09:00:00Z", "2026-11-18T09:29:00Z"]) {
      const lead = forYouNow(input(at, { briefing: null, meetings: [handover] })).lead!;
      expect(lead).toMatchObject({ key: "meeting:a", timing: "In progress, ends 10:30", actions: ["join", "calendar", "done", "not-now", "open-prep"], meeting: { phase: "in-progress" } });
      expect(lead.why).toBe("A meeting with other people, in progress. It is here until it ends at 10:30, or until Done or Not now.");
    }
  });

  it("leaves at the scheduled end", () => {
    expect(all(forYouNow(input("2026-11-18T09:30:00Z", { briefing: null, meetings: [handover] })))).toEqual([]);
  });

  it("leads with Open in Google Calendar when the meeting has no call to join", () => {
    const noCall = prep("c", "2026-11-18T09:00:00Z", "2026-11-18T09:30:00Z", { meetLink: null });
    expect(forYouNow(input("2026-11-18T09:10:00Z", { briefing: null, meetings: [noCall] })).lead!.actions).toEqual(["calendar", "done", "not-now", "open-prep"]);
    expect(forYouNow(input("2026-11-18T08:50:00Z", { briefing: null, meetings: [noCall] })).lead!.actions).toEqual(["open-prep", "calendar", "done", "not-now"]);
  });

  it("back to back: the next meeting comes in 15 minutes before its start, below the one in progress, then the briefing", () => {
    expect(keysOf(forYouNow(input("2026-11-18T09:14:00Z", { meetings: [triage, handover] })))).toEqual(["meeting:a", "briefing:b1"]);
    const overlap = forYouNow(input("2026-11-18T09:20:00Z", { meetings: [triage, handover] }));
    expect(overlap.lead).toMatchObject({ key: "meeting:a", timing: "In progress, ends 10:30" });
    expect(overlap.followers).toMatchObject([
      { key: "meeting:b", form: "card", timing: "Starts 10:30", title: "Billing triage", meeting: { interval: "10:30 to 11:00" } },
      { key: "briefing:b1", kind: "daily-briefing" },
    ]);
    // At 10:30 the first one has ended and the next one is in progress, still above the briefing.
    const next = forYouNow(input("2026-11-18T09:30:00Z", { meetings: [triage, handover] }));
    expect(keysOf(next)).toEqual(["meeting:b", "briefing:b1"]);
    expect(next.lead!.timing).toBe("In progress, ends 11:00");
  });

  it("two meetings at the same minute go by their stable key, the same on every tick", () => {
    const same = [prep("z", "2026-11-18T09:00:00Z", "2026-11-18T09:30:00Z"), prep("x", "2026-11-18T09:00:00Z", "2026-11-18T10:00:00Z"), prep("y", "2026-11-18T09:00:00Z", "2026-11-18T10:00:00Z")];
    for (const at of ["2026-11-18T08:50:00Z", "2026-11-18T09:10:00Z"]) expect(keysOf(forYouNow(input(at, { briefing: null, meetings: same })))).toEqual(["meeting:x", "meeting:y", "meeting:z"]);
    // Both lead in turn only as the order allows: one lead, the others follow.
    expect(forYouNow(input("2026-11-18T09:10:00Z", { briefing: null, meetings: same })).followers.map((h) => h.form)).toEqual(["card", "card"]);
  });

  it("Not now hides that meeting only", () => {
    const slot = forYouNow(input("2026-11-18T09:20:00Z", { briefing: null, meetings: [triage, handover], settled: new Set(["meeting:a"]) }));
    expect(keysOf(slot)).toEqual(["meeting:b"]);
  });

  it("shows its times in the zone the browser is in now", () => {
    expect(forYouNow(input("2026-11-18T09:10:00Z", { briefing: null, meetings: [handover], timeZone: "America/New_York" })).lead!.timing).toBe("In progress, ends 04:30");
  });

  it("finds its related notes in the latest briefing by the item's id, never by title, labelled with that briefing's time", () => {
    const related = [{ title: "Nora Lind", relPath: "memory/people/nora-lind.md", lines: [3, 9] as [number, number] }];
    const found = briefing({ sections: [{ id: "meetings", title: "Meetings", items: [{ id: "a", title: "Somewhere else", summary: "", url: null, isNew: true, changed: false, related }, { id: "x", title: "Prepare for Billing triage", summary: "", url: null, isNew: true, changed: false, related }] }] });
    const slot = forYouNow(input("2026-11-18T09:20:00Z", { briefing: found, meetings: [handover, triage] }));
    expect(all(slot).find((h) => h.key === "meeting:a")!.meeting!.notes).toEqual({ related, foundAt: Date.parse("2026-11-18T07:02:00Z") });
    // The same title under another id is not this meeting: no briefing looked at it.
    expect(all(slot).find((h) => h.key === "meeting:b")!.meeting!.notes).toBeNull();
    // A briefing that looked and found nothing says so with an empty list.
    const none = briefing({ sections: [{ id: "meetings", title: "Meetings", items: [{ id: "a", title: "", summary: "", url: null, isNew: false, changed: false, related: [] }] }] });
    expect(forYouNow(input("2026-11-18T09:20:00Z", { briefing: none, meetings: [handover] })).lead!.meeting!.notes).toEqual({ related: [], foundAt: Date.parse("2026-11-18T07:02:00Z") });
  });

  it("makes no claim that nothing is timely while the open items are not known", () => {
    expect(forYouNow(input("2026-11-18T05:00:00Z", { briefing: null, meetings: "unknown" })).quiet).toBeNull();
  });

  it("ignores items that are not meeting prep or carry no meeting", () => {
    const old = { ...handover, id: "old", meeting: null };
    const review = { ...handover, id: "r", kind: "review_request" };
    expect(all(forYouNow(input("2026-11-18T09:10:00Z", { briefing: null, meetings: [old, review] })))).toEqual([]);
  });
});

describe("the meetings promoted above the Inbox", () => {
  it("are the meeting prep items For you now shows, in the lead, the followers or the disclosure", () => {
    const meetings = [handover, triage, prep("c", "2026-11-18T09:30:00Z", "2026-11-18T10:00:00Z"), prep("d", "2026-11-18T09:30:00Z", "2026-11-18T10:00:00Z")];
    const slot = forYouNow(input("2026-11-18T09:20:00Z", { meetings }));
    expect([...promotedMeetings(slot)]).toEqual(["a", "b", "c", "d"]);
    expect(slot.more.map((h) => h.key)).toEqual(["meeting:d", "briefing:b1"]);
    expect(promotedMeetings(forYouNow(input("2026-11-18T07:00:00Z", { meetings })))).toEqual(new Set());
  });
});

describe("a meeting that comes due while the Heads-ups are held", () => {
  // Held at 10:14, while only the meeting in progress was timely; at 10:15 the next one comes due.
  const held = forYouNow(input("2026-11-18T09:14:00Z", { meetings: [triage, handover] }));
  const live = forYouNow(input("2026-11-18T09:15:00Z", { meetings: [triage, handover] }));

  it("comes in on time below the held entry, before the briefing, and the held lead stays as it was", () => {
    expect(keysOf(held)).toEqual(["meeting:a", "briefing:b1"]);
    const { slot } = withArrivedMeetings(held, live, ["meeting:a"]);
    expect(slot.lead).toBe(held.lead);
    expect(keysOf(slot)).toEqual(["meeting:a", "meeting:b", "briefing:b1"]);
    expect(promotedMeetings(slot)).toEqual(new Set(["a", "b"]));
  });

  it("never comes in above what the pointer or focus is on", () => {
    expect(keysOf(withArrivedMeetings(held, live, ["briefing:b1"]).slot)).toEqual(["meeting:a", "briefing:b1", "meeting:b"]);
    // Held somewhere that is no entry (between rows): it goes last, so nothing moves under the owner.
    expect(keysOf(withArrivedMeetings(held, live, []).slot)).toEqual(["meeting:a", "briefing:b1", "meeting:b"]);
  });

  it("keeps where it came in for the rest of the hold, also once the pointer or focus moves onto it", () => {
    const first = withArrivedMeetings(held, live, ["meeting:a"]);
    expect(keysOf(first.slot)).toEqual(["meeting:a", "meeting:b", "briefing:b1"]);
    for (const holding of [["meeting:b"], [], ["briefing:b1", "meeting:b"]]) expect(keysOf(withArrivedMeetings(held, live, holding, first.placed).slot)).toEqual(["meeting:a", "meeting:b", "briefing:b1"]);
  });

  it("brings nothing else in: a briefing or a clock change still waits", () => {
    const later = forYouNow(input("2026-11-18T11:30:00Z", { meetings: [] }));
    expect(withArrivedMeetings(held, later, ["meeting:a"]).slot).toEqual(held);
  });
});
