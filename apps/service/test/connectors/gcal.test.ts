import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { gcalAdapter, looksAllDay, parseEventPage } from "../../src/connectors/gcal.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { fixtureContext } from "../fixtures/adapter-harness.ts";
import { jsonAnswer, mountClaude, onTool, useFakeClaude, type ClaudeFixture } from "../fixtures/claude-connectors.ts";

// Each test starts many fake Claude Code processes one after another, which is slow while other suites share the machine.
vi.setConfig({ testTimeout: 120_000 });

let fx: FixtureServer;
let claude: ClaudeFixture;
const SERVER = "claude.ai Google Calendar";
beforeAll(async () => {
  fx = await startFixtureServer();
  useFakeClaude(fx.url);
});
afterAll(() => fx.close());
beforeEach(() => {
  fx.reset();
  claude = mountClaude(fx);
});

const NOW = Date.parse("2026-09-30T10:00:00Z");
const iso = (hoursFromNow: number) => new Date(NOW + hoursFromNow * 3_600_000).toISOString().replace(".000Z", "Z");

const ctx = (opts: { scopes?: string[] } = {}) => fixtureContext({ kind: "gcal", baseUrl: fx.url, settings: { authMethod: "claude-ai" }, readScopes: opts.scopes ?? ["upcoming"], selfEmail: "alex@acme.com", now: new Date(NOW) });

const me = (responseStatus = "accepted") => ({ email: "alex@acme.com", self: true, responseStatus });
const guest = (name: string) => ({ email: `${name.toLowerCase()}@client.com`, displayName: name, responseStatus: "accepted" });

const event = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  status: "confirmed",
  summary: `Meeting ${id}`,
  htmlLink: `https://calendar.google.com/event?eid=${id}`,
  start: { dateTime: iso(2) },
  end: { dateTime: iso(3) },
  attendees: [me(), guest("Mia")],
  ...extra,
});

const events = (items: unknown[]) => onTool(claude, SERVER, "list_events", () => jsonAnswer({ events: items, summary: "alex@acme.com", timeZone: "Europe/Copenhagen" }));
const calls = () => claude.calls.filter((c) => c.tool === "list_events");

describe("looksAllDay", () => {
  it("detects date-only and midnight-to-midnight whole-day spans", () => {
    expect(looksAllDay({ date: "2026-10-01" }, { date: "2026-10-02" })).toBe(true);
    expect(looksAllDay({ dateTime: "2026-10-01T00:00:00+02:00" }, { dateTime: "2026-10-02T00:00:00+02:00" })).toBe(true);
    expect(looksAllDay({ dateTime: "2026-10-01T00:00:00Z" }, { dateTime: "2026-10-04T00:00:00Z" })).toBe(true);
    // Across a DST change the wall-clock days are still whole (23h elapsed).
    expect(looksAllDay({ dateTime: "2026-10-25T00:00:00+02:00" }, { dateTime: "2026-10-26T00:00:00+01:00" })).toBe(true);
  });

  it("rejects timed events, midnight-to-noon, and zero-length midnight events", () => {
    expect(looksAllDay({ dateTime: "2026-10-01T09:00:00+02:00" }, { dateTime: "2026-10-01T10:00:00+02:00" })).toBe(false);
    expect(looksAllDay({ dateTime: "2026-10-01T00:00:00+02:00" }, { dateTime: "2026-10-01T12:00:00+02:00" })).toBe(false);
    expect(looksAllDay({ dateTime: "2026-10-01T00:00:00+02:00" }, { dateTime: "2026-10-01T00:00:00+02:00" })).toBe(false);
    expect(looksAllDay({ dateTime: "2026-10-01T00:00:30+02:00" }, { dateTime: "2026-10-02T00:00:00+02:00" })).toBe(false);
    expect(looksAllDay(undefined, undefined)).toBe(false);
  });
});

describe("Google Calendar adapter contract (claude.ai Google Calendar connector)", () => {
  it("authorization: test reads one event page and reports the calendar; an unconnected connector is unauthorized", async () => {
    events([]);
    expect(await gcalAdapter.test(ctx())).toMatchObject({ ok: true, account: "alex@acme.com" });
    expect(calls()[0]!.args.pageSize).toBe(1);
    claude.servers = [{ name: SERVER, status: "needs-auth", source: "claudeai" }];
    expect(await gcalAdapter.test(ctx())).toMatchObject({ ok: false, state: "unauthorized" });
    expect((await gcalAdapter.refresh!(ctx())).coverage.state).toBe("unauthorized");
  });

  it("scope: nothing read unless 'upcoming' is selected; a permission error is denied", async () => {
    await gcalAdapter.refresh!(ctx({ scopes: [] }));
    expect(claude.calls).toHaveLength(0);
    onTool(claude, SERVER, "list_events", () => ({ text: "PERMISSION_DENIED: insufficient scopes", isError: true }));
    expect((await gcalAdapter.refresh!(ctx())).coverage.state).toBe("denied");
  });

  it("queries the next 48 hours ordered by start", async () => {
    events([]);
    await gcalAdapter.refresh!(ctx());
    expect(calls()[0]!.args).toEqual({ startTime: "2026-09-30T10:00:00.000Z", endTime: "2026-10-02T10:00:00.000Z", orderBy: "startTime", pageSize: 100 });
  });

  it("pagination: follows nextPageToken; a page cap is partial", async () => {
    onTool(claude, SERVER, "list_events", (a) => jsonAnswer(a.pageToken === "p2" ? { events: [event("b")] } : { events: [event("a")], nextPageToken: "p2" }));
    const s = await gcalAdapter.refresh!(ctx());
    expect(s.observations.map((o) => o.externalId)).toEqual(["a", "b"]);
    expect(s.coverage.scopes[0]).toMatchObject({ state: "complete", pages: 2 });
    let n = 0;
    onTool(claude, SERVER, "list_events", () => jsonAnswer({ events: [event(`e${++n}`)], nextPageToken: `p${n + 1}` }));
    expect((await gcalAdapter.refresh!(ctx())).coverage.scopes[0]).toMatchObject({ state: "partial", pages: 3 });
  });

  it("pagination: every page repeats the first page's time window; an error inside the result is not zero events", async () => {
    let n = 0;
    onTool(claude, SERVER, "list_events", (a) => jsonAnswer(++n < 3 ? { events: [event(`e${n}`)], nextPageToken: `p${n}` } : { events: [event("last")], args: a }));
    await gcalAdapter.refresh!(ctx());
    const windows = new Set(calls().map((c) => `${String(c.args.startTime)}|${String(c.args.endTime)}`));
    expect(windows.size).toBe(1);
    onTool(claude, SERVER, "list_events", () => jsonAnswer({ error: "Backend Error 503" }));
    expect((await gcalAdapter.refresh!(ctx())).coverage.state).toBe("offline");
  });

  it("empty result is 'empty'; a failure after page one is partial; an unreadable page is an error", async () => {
    events([]);
    expect((await gcalAdapter.refresh!(ctx())).coverage.scopes[0]).toMatchObject({ state: "empty", items: 0 });
    onTool(claude, SERVER, "list_events", (a) => (a.pageToken ? { text: "Backend Error 503", isError: true } : jsonAnswer({ events: [event("a")], nextPageToken: "p2" })));
    const s = await gcalAdapter.refresh!(ctx());
    expect(s.coverage.state).toBe("partial");
    expect(s.observations).toHaveLength(1);
    onTool(claude, SERVER, "list_events", () => ({ text: "<html>oops</html>" }));
    expect((await gcalAdapter.refresh!(ctx())).coverage.state).toBe("error");
  });

  it("events that cannot be read make the scope partial, and the note counts them", async () => {
    events([event("a"), { nope: 1 }]);
    const one = await gcalAdapter.refresh!(ctx());
    expect(one.coverage.scopes[0]).toMatchObject({ state: "partial", items: 1, note: "1 event could not be read" });
    events([event("a"), { nope: 1 }, { nope: 2 }]);
    expect((await gcalAdapter.refresh!(ctx())).coverage.scopes[0]!.note).toBe("2 events could not be read");
  });

  it("disconnect: with Claude Code signed out nothing is read and the state is unauthorized", async () => {
    claude.mode = "not-logged-in";
    events([event("a")]);
    expect((await gcalAdapter.refresh!(ctx())).coverage.state).toBe("unauthorized");
    expect(claude.calls).toHaveLength(0);
  });

  it("meeting prep: timed, within 24h, 2+ attendees, not declined; all-day, solo, declined and later events excluded", async () => {
    const many = ["Ana", "Ben", "Cai", "Dee", "Eli", "Fay", "Gus", "Hal"].map(guest);
    events([
      event("prep", { attendees: [me(), ...many, { email: "room@acme.com", resource: true, responseStatus: "accepted" }] }),
      event("allday", { start: { date: "2026-09-30" }, end: { date: "2026-10-01" } }),
      event("midnight", { start: { dateTime: "2026-10-01T00:00:00+02:00" }, end: { dateTime: "2026-10-02T00:00:00+02:00" } }),
      event("solo", { attendees: [me()] }),
      event("noattendees", { attendees: undefined }),
      event("declined", { attendees: [me("declined"), guest("Mia")] }),
      event("later", { start: { dateTime: iso(30) }, end: { dateTime: iso(31) } }),
      event("cancelled", { status: "cancelled" }),
    ]);
    const s = await gcalAdapter.refresh!(ctx());
    const by = Object.fromEntries(s.observations.map((o) => [o.externalId, o]));
    expect(by.cancelled).toBeUndefined();
    expect(s.observations.filter((o) => o.attention).map((o) => o.externalId)).toEqual(["prep"]);
    const a = by.prep!.attention!;
    expect(a).toMatchObject({ key: "gcal:prep", kind: "meeting_prep" });
    expect(a.summary).toBe(`Starts ${iso(2).slice(0, 16).replace("T", " ")} with Ana, Ben, Cai, Dee, Eli, Fay (+2 more).`);
    expect(by.prep!.fingerprintParts).toEqual([iso(2), iso(3), "accepted", 9]);
    expect(by.midnight!.data.allDay).toBe(true);
    expect(by.declined!.data.selfResponseStatus).toBe("declined");
  });

  it("invites awaiting my response become invite_response; accepting keeps the key and changes the fingerprint", async () => {
    let status = "needsAction";
    onTool(claude, SERVER, "list_events", () => jsonAnswer({ events: [event("inv", { attendees: [me(status), guest("Mia")] })] }));
    const before = (await gcalAdapter.refresh!(ctx())).observations[0]!;
    status = "accepted";
    const after = (await gcalAdapter.refresh!(ctx())).observations[0]!;
    expect(before.attention).toMatchObject({ key: "gcal:inv", kind: "invite_response" });
    expect(after.attention).toMatchObject({ key: "gcal:inv", kind: "meeting_prep" });
    expect(after.fingerprintParts).not.toEqual(before.fingerprintParts);
  });

  it("read-only: no write actions, and the page parser tolerates the REST 'items' key", () => {
    expect(gcalAdapter.definition.writeActions).toEqual([]);
    expect(parseEventPage(JSON.stringify({ items: [{ id: "x" }, { nope: 1 }] }))).toMatchObject({ unreadable: 1, next: null });
  });
});
