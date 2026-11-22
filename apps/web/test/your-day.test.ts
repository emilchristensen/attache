import { describe, expect, it } from "vitest";
import type { AgendaEvent } from "@attache/contracts";
import { yourDay, YOUR_DAY_VISIBLE } from "../src/your-day.ts";
import { MEETING_LEAD_MS } from "../src/heads-up-rules.ts";

const NOW = Date.parse("2026-11-20T10:00:00Z");
const event = (id: string, start: string, end: string, extra: Partial<AgendaEvent> = {}): AgendaEvent => ({ id, start, end, allDay: false, title: id, response: "accepted", calendarUrl: `https://calendar.google.com/${id}`, meetLink: null, ...extra });

const base = { now: NOW, timeZone: "Europe/Copenhagen", connection: { id: "gcal", status: "connected" } as const, readAt: "2026-11-20T08:00:00Z", coverage: { state: "complete", scopes: [], items: 4, at: "2026-11-20T08:00:00Z" } as const };

describe("Your day", () => {
  it("shows events overlapping today in start order, puts all-day first, and leaves declined out", () => {
    const view = yourDay({ ...base, events: [event("later", "2026-11-20T13:00:00Z", "2026-11-20T13:30:00Z"), event("declined", "2026-11-20T09:00:00Z", "2026-11-20T09:30:00Z", { response: "declined" }), event("all-day", "2026-11-20", "2026-11-21", { allDay: true }), event("early", "2026-11-20T08:00:00Z", "2026-11-20T08:30:00Z")] });
    expect(view.events.map((e) => e.id)).toEqual(["all-day", "early", "later"]);
    expect(view.events[1]).toMatchObject({ phase: "ended" });
  });

  it("marks the meeting in progress and the Join window with the meeting prep constant", () => {
    const start = NOW + MEETING_LEAD_MS;
    const meet = event("meet", new Date(start).toISOString(), new Date(start + 30 * 60_000).toISOString(), { meetLink: "https://meet.google.com/abc" });
    const before = yourDay({ ...base, now: start - MEETING_LEAD_MS - 1, events: [meet] });
    const joins = yourDay({ ...base, now: start - MEETING_LEAD_MS, events: [meet] });
    const running = yourDay({ ...base, now: start + 1, events: [meet] });
    const after = yourDay({ ...base, now: start + 30 * 60_000, events: [meet] });
    expect(before.events[0]?.joinable).toBe(false);
    expect(joins.events[0]?.joinable).toBe(true);
    expect(running.events[0]).toMatchObject({ phase: "in-progress", joinable: true });
    expect(after.events[0]).toMatchObject({ phase: "ended", joinable: false });
  });

  it("recomputes today's range when the time zone changes", () => {
    const instant = event("crosses", "2026-11-20T23:30:00Z", "2026-11-21T00:30:00Z");
    expect(yourDay({ ...base, timeZone: "UTC", events: [instant] }).events.map((e) => e.id)).toEqual(["crosses"]);
    const allDay = event("local-day", "2026-11-20", "2026-11-21", { allDay: true });
    expect(yourDay({ ...base, timeZone: "Pacific/Honolulu", events: [allDay] }).events.map((e) => e.id)).toEqual(["local-day"]);
    expect(yourDay({ ...base, now: Date.parse("2026-11-20T12:00:00Z"), timeZone: "Pacific/Honolulu", events: [instant] }).events.map((e) => e.id)).toEqual(["crosses"]);
    expect(yourDay({ ...base, now: Date.parse("2026-11-21T11:00:00Z"), timeZone: "Pacific/Honolulu", events: [instant] }).events.map((e) => e.id)).toEqual([]);
  });

  it("names tomorrow's first meeting once today's have ended, and not an all-day event", () => {
    const ended = event("ended", "2026-11-20T07:00:00Z", "2026-11-20T08:00:00Z");
    const holiday = event("holiday", "2026-11-21", "2026-11-22", { allDay: true });
    const standup = event("standup", "2026-11-21T08:00:00Z", "2026-11-21T08:15:00Z");
    expect(yourDay({ ...base, events: [ended, holiday, standup] })).toMatchObject({ state: "nothing-more", tomorrow: { id: "standup" } });
  });

  it("returns honest empty, stale, disconnected and switched-off states and limits the wide row", () => {
    const ended = event("ended", "2026-11-20T07:00:00Z", "2026-11-20T08:00:00Z");
    expect(yourDay({ ...base, events: [ended] }).state).toBe("nothing-more");
    expect(yourDay({ ...base, events: [], readAt: "2026-11-20T08:00:00Z" }).state).toBe("empty");
    expect(yourDay({ ...base, events: [], readAt: null, coverage: null }).state).toBe("checking");
    expect(yourDay({ ...base, events: [event("tomorrow", "2026-11-21T08:00:00Z", "2026-11-21T09:00:00Z")] }).state).toBe("nothing-more");
    expect(yourDay({ ...base, events: [], coverage: { ...base.coverage, state: "offline" } }).state).toBe("error");
    expect(yourDay({ ...base, events: [], connection: null }).state).toBe("unconnected");
    expect(yourDay({ ...base, enabled: false, events: [] }).state).toBe("off");
    const meetings = Array.from({ length: YOUR_DAY_VISIBLE + 3 }, (_, i) => event(`e${i}`, `2026-11-20T${String(i).padStart(2, "0")}:00:00Z`, `2026-11-20T${String(i).padStart(2, "0")}:30:00Z`));
    const allDay = Array.from({ length: 3 }, (_, i) => event(`day-${i}`, "2026-11-20", "2026-11-21", { allDay: true }));
    const view = yourDay({ ...base, events: [...allDay, ...meetings] });
    expect(view.events.filter((e) => e.allDay && e.visible)).toHaveLength(3);
    expect(view.events.filter((e) => !e.allDay && e.visible)).toHaveLength(YOUR_DAY_VISIBLE);
    expect(view.more).toBe(3);
  });
});
