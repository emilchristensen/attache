import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gcalAdapter, looksAllDay, GCAL_READ_SCOPE } from "../../src/connectors/gcal.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { fixtureContext } from "../fixtures/adapter-harness.ts";

let fx: FixtureServer;
beforeAll(async () => {
  fx = await startFixtureServer();
});
afterAll(() => fx.close());
beforeEach(() => fx.reset());

const NOW = Date.parse("2026-09-30T10:00:00Z");
const EVENTS = "/calendar/v3/calendars/primary/events";
const CLIENT_ID = "123-abc.apps.googleusercontent.com";
const iso = (hoursFromNow: number) => new Date(NOW + hoursFromNow * 3_600_000).toISOString().replace(".000Z", "Z");

const validSecrets = () => ({ clientSecret: "GOCSPX-testsecret", refreshToken: "1//refresh-token", accessToken: "ya29.valid-access", accessTokenExpiresAt: new Date(NOW + 3_600_000).toISOString() });

const ctx = (opts: { scopes?: string[]; secrets?: Record<string, string> } = {}) =>
  fixtureContext({ kind: "gcal", baseUrl: fx.url, secrets: opts.secrets ?? validSecrets(), settings: { clientId: CLIENT_ID, grantedScopes: GCAL_READ_SCOPE }, readScopes: opts.scopes ?? ["upcoming"], selfEmail: "alex@acme.com" });

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

const events = (items: unknown[]) => fx.route("GET", EVENTS, () => ({ json: { items } }));

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

describe("Google Calendar adapter contract", () => {
  it("authorization: sends the bearer token and reports the primary calendar", async () => {
    fx.route("GET", "/calendar/v3/users/me/calendarList", (req) => (req.headers.authorization === "Bearer ya29.valid-access" ? { json: { items: [{ id: "alex@acme.com", primary: true }] } } : { status: 401, json: {} }));
    expect(await gcalAdapter.test(ctx())).toMatchObject({ ok: true, account: "alex@acme.com" });
    expect(fx.requests[0]!.query.get("maxResults")).toBe("1");
  });

  it("token refresh on expiry; invalid_grant is 'unauthorized'", async () => {
    fx.route("POST", "/token", (req) => ((req.body as Record<string, string>).refresh_token === "1//refresh-token" ? { json: { access_token: "ya29.fresh", expires_in: 3600 } } : { status: 400, json: { error: "invalid_grant" } }));
    fx.route("GET", EVENTS, (req) => (req.headers.authorization === "Bearer ya29.fresh" ? { json: { items: [] } } : { status: 401, json: {} }));
    const expired = { ...validSecrets(), accessTokenExpiresAt: new Date(NOW - 1).toISOString() };
    expect((await gcalAdapter.sync!(ctx({ secrets: expired }))).coverage.state).toBe("empty");
    const revoked = await gcalAdapter.sync!(ctx({ secrets: { ...expired, refreshToken: "1//revoked" } }));
    expect(revoked.coverage.state).toBe("unauthorized");
    expect(revoked.coverage.scopes[0]!.note).toMatch(/invalid_grant/);
  });

  it("scope: nothing read unless 'upcoming' is selected; 403 is denied", async () => {
    await gcalAdapter.sync!(ctx({ scopes: [] }));
    expect(fx.requests).toHaveLength(0);
    fx.route("GET", EVENTS, () => ({ status: 403, json: { error: { message: "insufficient scopes" } } }));
    expect((await gcalAdapter.sync!(ctx())).coverage.state).toBe("denied");
  });

  it("queries the next 48 hours as single events ordered by start", async () => {
    events([]);
    await gcalAdapter.sync!(ctx());
    const q = fx.requests[0]!.query;
    expect(Object.fromEntries(q)).toMatchObject({ timeMin: "2026-09-30T10:00:00.000Z", timeMax: "2026-10-02T10:00:00.000Z", singleEvents: "true", orderBy: "startTime", maxResults: "100" });
  });

  it("pagination: follows nextPageToken; page cap is partial", async () => {
    fx.route("GET", EVENTS, (req) => (req.query.get("pageToken") === "p2" ? { json: { items: [event("b")] } } : { json: { items: [event("a")], nextPageToken: "p2" } }));
    const s = await gcalAdapter.sync!(ctx());
    expect(s.observations.map((o) => o.externalId)).toEqual(["a", "b"]);
    expect(s.coverage.scopes[0]).toMatchObject({ state: "complete", pages: 2 });
    fx.reset();
    let n = 0;
    fx.route("GET", EVENTS, () => ({ json: { items: [event(`e${++n}`)], nextPageToken: `p${n + 1}` } }));
    expect((await gcalAdapter.sync!(ctx())).coverage.scopes[0]).toMatchObject({ state: "partial", pages: 3 });
  });

  it("retry: retries 429 honouring Retry-After, then succeeds", async () => {
    let calls = 0;
    fx.route("GET", EVENTS, () => (++calls < 2 ? { status: 429, headers: { "retry-after": "0" }, json: {} } : { json: { items: [] } }));
    expect((await gcalAdapter.sync!(ctx())).coverage.state).toBe("empty");
    expect(calls).toBe(2);
  });

  it("empty result is 'empty'; a failure after page one is partial", async () => {
    events([]);
    expect((await gcalAdapter.sync!(ctx())).coverage.scopes[0]).toMatchObject({ state: "empty", items: 0 });
    fx.reset();
    fx.route("GET", EVENTS, (req) => (req.query.get("pageToken") ? { status: 503, json: {} } : { json: { items: [event("a")], nextPageToken: "p2" } }));
    const s = await gcalAdapter.sync!(ctx());
    expect(s.coverage.state).toBe("partial");
    expect(s.observations).toHaveLength(1);
  });

  it("disconnect: without stored tokens no request is made", async () => {
    const s = await gcalAdapter.sync!(ctx({ secrets: {} }));
    expect(s.coverage.state).toBe("unauthorized");
    expect(fx.requests).toHaveLength(0);
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
    const s = await gcalAdapter.sync!(ctx());
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
    fx.route("GET", EVENTS, () => ({ json: { items: [event("inv", { attendees: [me(status), guest("Mia")] })] } }));
    const before = (await gcalAdapter.sync!(ctx())).observations[0]!;
    status = "accepted";
    const after = (await gcalAdapter.sync!(ctx())).observations[0]!;
    expect(before.attention).toMatchObject({ key: "gcal:inv", kind: "invite_response" });
    expect(after.attention).toMatchObject({ key: "gcal:inv", kind: "meeting_prep" });
    expect(after.fingerprintParts).not.toEqual(before.fingerprintParts);
  });

  it("OAuth: authorize URL requests calendar.readonly by default", async () => {
    const url = new URL(await gcalAdapter.authorizeUrl!(ctx(), { redirectUri: "http://127.0.0.1:1/cb", state: "s", codeChallenge: "c", scopes: [] }));
    expect(url.searchParams.get("scope")).toBe(GCAL_READ_SCOPE);
    expect(gcalAdapter.definition.writeActions).toEqual([]);
  });
});
