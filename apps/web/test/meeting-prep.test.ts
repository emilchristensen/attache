import { describe, expect, it } from "vitest";
import type { AttentionItemView, BriefingView } from "@attache/contracts";
import { meetingPrep } from "../src/meeting-prep.ts";

const NOTE = { title: "Nora Lind", relPath: "people/nora-lind.md", lines: [1, 4] as [number, number] };

function prep(over: Partial<AttentionItemView> = {}): AttentionItemView {
  return {
    id: "prep-1",
    key: "gcal:handover",
    kind: "meeting_prep",
    title: "Prepare for Pilot handover",
    summary: "",
    why: null,
    sourceKind: "gcal",
    connectionId: "gcal",
    url: "https://calendar.google.com/event?eid=handover",
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
    meeting: { start: "2026-11-18T13:30:00Z", end: "2026-11-18T14:00:00Z", meetLink: null, attendees: ["Nora Lind", "Sam Berg"] },
    ...over,
  };
}

function briefing(id: string, createdAt: string, related: Array<typeof NOTE> | undefined): BriefingView {
  const item = { id: "prep-1", title: "Prepare for Pilot handover", summary: "", url: null, isNew: false, changed: false, ...(related ? { related } : {}) };
  return { id, kind: "daily", createdAt, since: null, summary: "", sections: related === undefined ? [] : [{ id: "meetings", title: "Meetings to prepare", items: [item] }], lead: null, topPicks: [], updates: [], coverage: [], counts: { open: 0, new: 0, changed: 0, drafts: 0, proposals: 0, failedSources: 0 }, deliverablePath: null };
}

describe("Open prep", () => {
  it("gives the meeting's interval in the current zone and who else is in it", () => {
    expect(meetingPrep(prep(), [], "Europe/Copenhagen")).toEqual({ interval: "14:30 to 15:00", attendees: ["Nora Lind", "Sam Berg"], notes: null });
  });

  it.each<[string, Array<BriefingView | null>, { related: Array<typeof NOTE>; foundAt: string } | null]>([
    ["no briefing looked at the meeting", [briefing("b1", "2026-11-18T07:00:00Z", undefined), null], null],
    ["the briefing that looked found notes", [briefing("b1", "2026-11-18T07:00:00Z", [NOTE])], { related: [NOTE], foundAt: "2026-11-18T07:00:00Z" }],
    ["the briefing that looked found none", [briefing("b1", "2026-11-18T07:00:00Z", [])], { related: [], foundAt: "2026-11-18T07:00:00Z" }],
    ["the newest of the briefings that looked counts", [briefing("old", "2026-11-18T07:00:00Z", [NOTE]), briefing("new", "2026-11-18T09:00:00Z", [])], { related: [], foundAt: "2026-11-18T09:00:00Z" }],
  ])("names what %s", (_, briefings, expected) => {
    const notes = meetingPrep(prep(), briefings, "Europe/Copenhagen")?.notes ?? null;
    expect(notes && { related: notes.related, foundAt: new Date(notes.foundAt).toISOString().replace(".000", "") }).toEqual(expected);
  });

  it("has no prep for any other item", () => {
    expect(meetingPrep(prep({ kind: "deadline" }), [], "UTC")).toBeNull();
    expect(meetingPrep(prep({ meeting: null }), [], "UTC")).toBeNull();
  });
});
