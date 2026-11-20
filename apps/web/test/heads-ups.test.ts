import { describe, expect, it } from "vitest";
import type { AttentionItemView } from "@attache/contracts";
import { endedMeetings, forYouNow, MEETING_LEAD_MS, promotedMeetings, withArrivedMeetings, RANK, type BriefingView, type HeadsUp, type HeadsUpInput } from "../src/heads-ups.ts";

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
    lead: null,
    topPicks: [],
    updates: [],
    coverage: [],
    counts: { open: 4, new: 1, changed: 0, drafts: 1, proposals: 0, failedSources: 0 },
    deliverablePath: "deliverables/briefings/2026-11-18.md",
    ...over,
  };
}

function input(at: string, over: Partial<HeadsUpInput> = {}): HeadsUpInput {
  return { now: Date.parse(at), timeZone: CPH, briefing: briefing(), briefingJob: null, settled: new Set(), schedule: { enabled: true, nextRunAt: "2026-11-19T07:00:00Z" }, meetings: [], ...over };
}

describe("briefings are outside For you now", () => {
  it("never adds a daily, away, manual or progress entry", () => {
    for (const briefingValue of [briefing(), briefing({ kind: "away" }), briefing({ kind: "manual" })]) {
      const slot = forYouNow(input("2026-11-18T09:30:00Z", { briefing: briefingValue, briefingJob: { id: "j1", progress: 0.5, note: "Composing briefing" } }));
      expect([slot.lead, ...slot.followers, ...slot.more].filter(Boolean)).toEqual([]);
      expect(slot.quiet).toBe("Nothing timely right now.");
    }
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
    expect(keysOf(forYouNow(input("2026-11-18T09:14:00Z", { meetings: [triage, handover] })))).toEqual(["meeting:a"]);
    const overlap = forYouNow(input("2026-11-18T09:20:00Z", { meetings: [triage, handover] }));
    expect(overlap.lead).toMatchObject({ key: "meeting:a", timing: "In progress, ends 10:30" });
    expect(overlap.followers).toMatchObject([
      { key: "meeting:b", form: "card", timing: "Starts 10:30", title: "Billing triage", meeting: { interval: "10:30 to 11:00" } },
    ]);
    // At 10:30 the first one has ended and the next one is in progress, still above the briefing.
    const next = forYouNow(input("2026-11-18T09:30:00Z", { meetings: [triage, handover] }));
    expect(keysOf(next)).toEqual(["meeting:b"]);
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
    expect(slot.more.map((h) => h.key)).toEqual(["meeting:d"]);
    expect(promotedMeetings(forYouNow(input("2026-11-18T07:00:00Z", { meetings })))).toEqual(new Set());
  });
});

describe("a held meeting that ends", () => {
  // Held at 10:29 with the meeting in progress and the next one below it; the first ends at 10:30.
  const held = forYouNow(input("2026-11-18T09:29:00Z", { meetings: [handover, triage] }));

  it("is named once its scheduled end has passed, so its place shows that it ended", () => {
    expect(keysOf(held)).toEqual(["meeting:a", "meeting:b"]);
    expect(endedMeetings(held, Date.parse("2026-11-18T09:29:59Z"))).toEqual(new Set());
    expect(endedMeetings(held, Date.parse("2026-11-18T09:30:00Z"))).toEqual(new Set(["meeting:a"]));
    expect(endedMeetings(held, Date.parse("2026-11-18T10:00:00Z"))).toEqual(new Set(["meeting:a", "meeting:b"]));
  });

  it("names only meetings: a briefing that leaves on its own clock is not a meeting that ended", () => {
    expect(endedMeetings(held, Date.parse("2026-11-19T12:00:00Z"))).toEqual(new Set(["meeting:a", "meeting:b"]));
  });
});

describe("a meeting that comes due while the Heads-ups are held", () => {
  // Held at 10:14, while only the meeting in progress was timely; at 10:15 the next one comes due.
  const held = forYouNow(input("2026-11-18T09:14:00Z", { meetings: [triage, handover] }));
  const live = forYouNow(input("2026-11-18T09:15:00Z", { meetings: [triage, handover] }));

  it("comes in on time below the held entry, and the held lead stays as it was", () => {
    expect(keysOf(held)).toEqual(["meeting:a"]);
    const { slot } = withArrivedMeetings(held, live, ["meeting:a"]);
    expect(slot.lead).toBe(held.lead);
    expect(keysOf(slot)).toEqual(["meeting:a", "meeting:b"]);
    expect(promotedMeetings(slot)).toEqual(new Set(["a", "b"]));
  });

  it("never comes in above what the pointer or focus is on", () => {
    expect(keysOf(withArrivedMeetings(held, live, ["briefing:b1"]).slot)).toEqual(["meeting:a", "meeting:b"]);
    // Held somewhere that is no entry (between rows): it goes last, so nothing moves under the owner.
    expect(keysOf(withArrivedMeetings(held, live, []).slot)).toEqual(["meeting:a", "meeting:b"]);
  });

  it("keeps where it came in for the rest of the hold, also once the pointer or focus moves onto it", () => {
    const first = withArrivedMeetings(held, live, ["meeting:a"]);
    expect(keysOf(first.slot)).toEqual(["meeting:a", "meeting:b"]);
    for (const holding of [["meeting:b"], [], ["meeting:b"]]) expect(keysOf(withArrivedMeetings(held, live, holding, first.placed).slot)).toEqual(["meeting:a", "meeting:b"]);
  });

  it("shows the meeting as it came in for the rest of the hold: a later Calendar refresh does not change its Join", () => {
    const first = withArrivedMeetings(held, live, ["meeting:a"]);
    const moved = forYouNow(input("2026-11-18T09:16:00Z", { meetings: [{ ...triage, meeting: { ...triage.meeting!, meetLink: "https://meet.google.com/new-link" } }, handover] }));
    const again = withArrivedMeetings(held, moved, ["meeting:b"], first.placed).slot;
    expect(all(again).find((h) => h.key === "meeting:b")!.meeting!.meetLink).toBe("https://meet.google.com/b");
  });

  it("keeps its place while briefing state changes", () => {
    const first = withArrivedMeetings(held, live, ["meeting:a"]);
    expect(keysOf(withArrivedMeetings(held, live, [], first.placed).slot)).toEqual(["meeting:a", "meeting:b"]);
  });

  it("lets Done or Not now pressed here take an arrived meeting out at once, still held", () => {
    const first = withArrivedMeetings(held, live, ["meeting:a"]);
    expect(keysOf(withArrivedMeetings(held, live, ["meeting:b"], first.placed, new Set(["meeting:b"])).slot)).toEqual(["meeting:a"]);
  });

  it("keeps a later arrival in its place when this tab settles the arrival it came in after", () => {
    // Two meetings come due in the same minute, below the held meeting in progress; Not now on the first of them.
    const third = prep("c", "2026-11-18T09:30:00Z", "2026-11-18T10:00:00Z");
    const both = forYouNow(input("2026-11-18T09:15:00Z", { meetings: [triage, handover, third] }));
    const first = withArrivedMeetings(held, both, ["meeting:a"]);
    expect(keysOf(first.slot)).toEqual(["meeting:a", "meeting:b", "meeting:c"]);
    const settled = withArrivedMeetings(held, both, ["meeting:a"], first.placed, new Set(["meeting:b"]));
    expect(keysOf(settled.slot)).toEqual(["meeting:a", "meeting:c"]);
    // And it stays there for the rest of the hold.
    expect(keysOf(withArrivedMeetings(held, both, ["meeting:c"], settled.placed, new Set(["meeting:b"])).slot)).toEqual(["meeting:a", "meeting:c"]);
  });

  it("keeps an arrival in its place when the held entry it came in after leaves (Not now on the lead)", () => {
    const first = withArrivedMeetings(held, live, ["meeting:a"]);
    // Not now on the lead: the held slot loses it, and the arrival stays at the top.
    const without = forYouNow(input("2026-11-18T09:14:00Z", { meetings: [triage, handover], settled: new Set(["meeting:a"]) }));
    expect(keysOf(withArrivedMeetings(without, live, [], first.placed, new Set(["meeting:a"])).slot)).toEqual(["meeting:b"]);
  });

  it("brings nothing else in: a briefing or a clock change still waits", () => {
    const later = forYouNow(input("2026-11-18T11:30:00Z", { meetings: [] }));
    expect(withArrivedMeetings(held, later, ["meeting:a"]).slot).toEqual(held);
  });
});
