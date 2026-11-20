import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestService, type TestService } from "./harness.ts";

let service: TestService;

beforeEach(async () => {
  service = await startTestService();
});
afterEach(async () => service?.stop());

function calendarEvents() {
  service.app.db.prepare("insert into connections (id, kind, label, status, settings, read_scopes, write_actions, created_at, updated_at, coverage) values ('gcal','gcal','Google Calendar','connected','{}','[\"upcoming\"]','[]','2026-11-20T08:00:00.000Z','2026-11-20T08:00:00.000Z',?)").run(JSON.stringify({ state: "complete", scopes: [], items: 4, at: "2026-11-20T08:00:00.000Z" }));
  service.app.db.prepare("insert into sync_runs (id, connection_id, started_at, finished_at, outcome, coverage, item_count) values ('read-1','gcal','2026-11-20T08:00:00.000Z','2026-11-20T08:01:00.000Z','complete',?,4)").run(JSON.stringify({ state: "complete", scopes: [], items: 4, at: "2026-11-20T08:00:00.000Z" }));
  const add = service.app.db.prepare("insert into observations (id, connection_id, kind, external_id, fingerprint, title, url, data, occurred_at, observed_at, first_seen_at) values (?,?,?,?,?,?,?,?,'2026-11-20T00:00:00.000Z','2026-11-20T08:01:00.000Z','2026-11-20T08:01:00.000Z')");
  add.run("before", "gcal", "calendar_event", "before", "x", "Yesterday", "https://calendar.google.com/before", JSON.stringify({ start: "2026-11-19T22:00:00Z", end: "2026-11-19T23:00:00Z", allDay: false, selfResponseStatus: "accepted", meetLink: null }));
  add.run("timed", "gcal", "calendar_event", "timed", "x", "Design review", "https://calendar.google.com/timed", JSON.stringify({ start: "2026-11-20T09:00:00Z", end: "2026-11-20T10:00:00Z", allDay: false, selfResponseStatus: "needsAction", meetLink: "https://meet.google.com/abc" }));
  add.run("all-day", "gcal", "calendar_event", "all-day", "x", "Focus day", "https://calendar.google.com/all-day", JSON.stringify({ start: "2026-11-20", end: "2026-11-21", allDay: true, selfResponseStatus: "accepted", meetLink: null }));
  add.run("declined", "gcal", "calendar_event", "declined", "x", "Declined", "https://calendar.google.com/declined", JSON.stringify({ start: "2026-11-20T11:00:00Z", end: "2026-11-20T12:00:00Z", allDay: false, selfResponseStatus: "declined", meetLink: null }));
}

describe("agenda route", () => {
  it("returns the requested range, including all-day events and excluding declined events, with the last complete read", async () => {
    calendarEvents();
    const agenda = await service.get("/agenda?from=2026-11-20T00:00:00.000Z&to=2026-11-21T00:00:00.000Z");
    expect(agenda).toMatchObject({ readAt: "2026-11-20T08:01:00.000Z", coverage: { state: "complete" } });
    expect(agenda.events.map((e: { id: string }) => e.id)).toEqual(["all-day", "timed"]);
    expect(agenda.events[0]).toMatchObject({ allDay: true, response: "accepted" });
  });

  it("keeps the last list and read time when the latest refresh failed", async () => {
    calendarEvents();
    service.app.db.prepare("update connections set coverage = ? where id = 'gcal'").run(JSON.stringify({ state: "offline", scopes: [], items: 0, at: "2026-11-20T09:01:00.000Z" }));
    const agenda = await service.get("/agenda?from=2026-11-20T00:00:00Z&to=2026-11-21T00:00:00Z");
    expect(agenda).toMatchObject({ readAt: "2026-11-20T08:01:00.000Z", coverage: { state: "offline" } });
    expect(agenda.events).toHaveLength(2);
  });
});
