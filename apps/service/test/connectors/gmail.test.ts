import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { gmailAdapter, GMAIL_COMPOSE_SCOPE, GMAIL_READ_SCOPE, isCalendarNotification } from "../../src/connectors/gmail.ts";
import { startFixtureServer, type FixtureServer, type FixtureResponse } from "../fixtures/fixture-server.ts";
import { fixtureContext } from "../fixtures/adapter-harness.ts";

let fx: FixtureServer;
beforeAll(async () => {
  fx = await startFixtureServer();
});
afterAll(() => fx.close());
beforeEach(() => fx.reset());

const NOW = Date.parse("2026-09-30T10:00:00Z");
const API = "/gmail/v1/users/me";
const SELF = "alex@acme.com";
const CLIENT_ID = "123-abc.apps.googleusercontent.com";

const validSecrets = () => ({ clientSecret: "GOCSPX-testsecret", refreshToken: "1//refresh-token", accessToken: "ya29.valid-access", accessTokenExpiresAt: new Date(NOW + 3_600_000).toISOString() });

const ctx = (opts: { scopes?: string[]; secrets?: Record<string, string>; granted?: string } = {}) =>
  fixtureContext({
    kind: "gmail",
    baseUrl: fx.url,
    secrets: opts.secrets ?? validSecrets(),
    settings: { clientId: CLIENT_ID, grantedScopes: opts.granted ?? GMAIL_READ_SCOPE },
    readScopes: opts.scopes ?? ["inbox_recent"],
    selfEmail: SELF,
  });

interface Msg {
  id: string;
  from?: string;
  subject?: string;
  labels?: string[];
  hoursAgo?: number | null;
}

const message = (m: Msg) => ({
  id: m.id,
  threadId: "t",
  labelIds: m.labels ?? ["INBOX"],
  snippet: `snippet ${m.id}`,
  ...(m.hoursAgo === null ? {} : { internalDate: String(NOW - (m.hoursAgo ?? 1) * 3_600_000) }),
  payload: {
    headers: [
      { name: "From", value: m.from ?? "Mia Jensen <mia@client.com>" },
      { name: "Subject", value: m.subject ?? "Budget" },
      { name: "Message-ID", value: `<${m.id}@mail.client.com>` },
    ],
  },
});

/** Mount a list of threads (id → messages oldest first) plus the thread-get route. */
function threads(map: Record<string, Msg[]>, opts: { pageSize?: number } = {}) {
  const ids = Object.keys(map);
  const size = opts.pageSize ?? 50;
  fx.route("GET", `${API}/threads`, (req) => {
    const start = Number(req.query.get("pageToken") ?? 0);
    const next = start + size < ids.length ? String(start + size) : undefined;
    return { json: { threads: ids.slice(start, start + size).map((id) => ({ id })), ...(next ? { nextPageToken: next } : {}) } };
  });
  fx.route("GET", new RegExp(`^${API}/threads/[^/]+$`), (req) => {
    const id = req.path.split("/").pop()!;
    return { json: { id, historyId: String(Math.random()), messages: map[id]!.map(message) } };
  });
}

const tokenRoute = (handler: (form: Record<string, string>) => FixtureResponse) => fx.route("POST", "/token", (req) => handler(req.body as Record<string, string>));
const apiRequests = () => fx.requests.filter((r) => r.path.startsWith(API));

describe("Gmail adapter contract", () => {
  it("authorization: sends the bearer access token and reports the address", async () => {
    fx.route("GET", `${API}/profile`, (req) => (req.headers.authorization === "Bearer ya29.valid-access" ? { json: { emailAddress: SELF } } : { status: 401, json: {} }));
    expect(await gmailAdapter.test(ctx())).toMatchObject({ ok: true, account: SELF, grantedScopes: [GMAIL_READ_SCOPE] });
  });

  it("token refresh: an expired access token is refreshed and stored before the call", async () => {
    tokenRoute((f) => (f.grant_type === "refresh_token" && f.refresh_token === "1//refresh-token" && f.client_id === CLIENT_ID && f.client_secret === "GOCSPX-testsecret" ? { json: { access_token: "ya29.fresh", expires_in: 3599 } } : { status: 400, json: { error: "invalid_request" } }));
    fx.route("GET", `${API}/profile`, (req) => (req.headers.authorization === "Bearer ya29.fresh" ? { json: { emailAddress: SELF } } : { status: 401, json: {} }));
    const c = ctx({ secrets: { ...validSecrets(), accessTokenExpiresAt: new Date(NOW - 1000).toISOString() } });
    expect(await gmailAdapter.test(c)).toMatchObject({ ok: true, account: SELF });
    expect(c.secrets.get("accessToken")).toBe("ya29.fresh");
    expect(Date.parse(c.secrets.get("accessTokenExpiresAt")!)).toBe(NOW + 3_599_000);
  });

  it("a 401 from the API forces one refresh and retries", async () => {
    tokenRoute(() => ({ json: { access_token: "ya29.second", expires_in: 3600 } }));
    fx.route("GET", `${API}/profile`, (req) => (req.headers.authorization === "Bearer ya29.second" ? { json: { emailAddress: SELF } } : { status: 401, json: {} }));
    expect((await gmailAdapter.test(ctx())).ok).toBe(true);
    expect(fx.requests.filter((r) => r.path === "/token")).toHaveLength(1);
  });

  it("invalid_grant on refresh is 'unauthorized' with a reconnect message", async () => {
    tokenRoute(() => ({ status: 400, json: { error: "invalid_grant", error_description: "Token has been expired or revoked." } }));
    const c = () => ctx({ secrets: { ...validSecrets(), accessToken: "", accessTokenExpiresAt: "" } });
    const t = await gmailAdapter.test(c());
    expect(t).toMatchObject({ ok: false, state: "unauthorized" });
    expect(t.message).toMatch(/Reconnect/);
    const s = await gmailAdapter.sync!(c());
    expect(s.coverage.state).toBe("unauthorized");
    expect(apiRequests()).toHaveLength(0);
  });

  it("scope: nothing is read when inbox_recent is not selected; a 403 is denied", async () => {
    const a = await gmailAdapter.sync!(ctx({ scopes: [] }));
    expect(fx.requests).toHaveLength(0);
    expect(a.coverage.state).toBe("never_run");
    fx.route("GET", `${API}/threads`, () => ({ status: 403, json: { error: { message: "Request had insufficient authentication scopes." } } }));
    expect((await gmailAdapter.sync!(ctx())).coverage.state).toBe("denied");
  });

  it("pagination: follows nextPageToken and queries the recent inbox", async () => {
    threads({ a: [{ id: "a1" }], b: [{ id: "b1" }], c: [{ id: "c1" }] }, { pageSize: 2 });
    const s = await gmailAdapter.sync!(ctx());
    expect(s.observations.map((o) => o.externalId)).toEqual(["a", "b", "c"]);
    expect(s.coverage.scopes[0]).toMatchObject({ state: "complete", pages: 2, items: 3 });
    expect(fx.requests.find((r) => r.path === `${API}/threads`)!.query.get("q")).toBe("in:inbox newer_than:7d");
    const get = fx.requests.find((r) => r.path === `${API}/threads/a`)!;
    expect(get.query.get("format")).toBe("metadata");
    expect(get.query.getAll("metadataHeaders")).toEqual(expect.arrayContaining(["From", "Subject", "Date", "Message-ID"]));
  });

  it("retry: retries 429 honouring Retry-After, then succeeds", async () => {
    let calls = 0;
    fx.route("GET", `${API}/threads`, () => (++calls < 3 ? { status: 429, headers: { "retry-after": "0" }, json: {} } : { json: {} }));
    const s = await gmailAdapter.sync!(ctx());
    expect(calls).toBe(3);
    expect(s.coverage.state).toBe("empty");
  });

  it("empty result: an empty inbox is 'empty', not failure", async () => {
    fx.route("GET", `${API}/threads`, () => ({ json: { resultSizeEstimate: 0 } }));
    expect((await gmailAdapter.sync!(ctx())).coverage.scopes[0]).toMatchObject({ state: "empty", items: 0, pages: 1 });
  });

  it("partial coverage: the 100-thread cap and a failure after page one", async () => {
    const many = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`t${i}`, [{ id: `m${i}` }]]));
    threads(many);
    const a = await gmailAdapter.sync!(ctx());
    expect(a.coverage.scopes[0]).toMatchObject({ state: "partial", items: 100 });
    expect(a.coverage.scopes[0]!.note).toMatch(/newest 100/);
    fx.reset();
    fx.route("GET", `${API}/threads`, (req) => (req.query.get("pageToken") ? { status: 500, json: {} } : { json: { threads: [{ id: "a" }], nextPageToken: "p2" } }));
    fx.route("GET", `${API}/threads/a`, () => ({ json: { id: "a", messages: [message({ id: "a1" })] } }));
    const b = await gmailAdapter.sync!(ctx());
    expect(b.coverage.state).toBe("partial");
    expect(b.observations).toHaveLength(1);
  });

  it("disconnect: without stored tokens no request is made", async () => {
    const s = await gmailAdapter.sync!(ctx({ secrets: { clientSecret: "GOCSPX-x" } }));
    expect(s.coverage.state).toBe("unauthorized");
    expect(fx.requests).toHaveLength(0);
  });

  it("classification: unread/important only from labels, own last message and calendar mail never await a reply, old threads dropped", async () => {
    threads({
      unread: [{ id: "u1", labels: ["INBOX", "UNREAD"] }],
      important: [{ id: "i1", labels: ["INBOX", "IMPORTANT"] }],
      readPlain: [{ id: "r1", subject: "UNREAD: quarterly numbers", labels: ["INBOX", "CATEGORY_UPDATES"] }],
      sentLast: [{ id: "s1", labels: ["INBOX", "UNREAD"], hoursAgo: 5 }, { id: "s2", labels: ["SENT"], from: "someone@alias.com", hoursAgo: 1 }],
      selfLast: [{ id: "x1", labels: ["UNREAD"], hoursAgo: 5 }, { id: "x2", from: `Alex <${SELF.toUpperCase()}>`, labels: ["INBOX"], hoursAgo: 1 }],
      invite: [{ id: "c1", subject: "Invitation: Sync @ Thu Oct 1", from: "Mia <mia@client.com>", labels: ["INBOX", "UNREAD", "IMPORTANT"] }],
      calNotify: [{ id: "c2", subject: "Heads up", from: "Google Calendar <calendar-notification@google.com>", labels: ["UNREAD"] }],
      old: [{ id: "o1", labels: ["UNREAD"], hoursAgo: 8 * 24 }],
      undated: [{ id: "n1", labels: ["UNREAD"], hoursAgo: null }],
    });
    const s = await gmailAdapter.sync!(ctx());
    const by = Object.fromEntries(s.observations.map((o) => [o.externalId, o]));
    expect(Object.keys(by).sort()).toEqual(["calNotify", "important", "invite", "readPlain", "selfLast", "sentLast", "unread"]);
    expect(by.unread!.attention).toMatchObject({ key: "gmail:unread", kind: "pending_reply", draftable: { actionKind: "gmail.draft", target: { threadId: "unread", to: "Mia Jensen <mia@client.com>", subject: "Budget", inReplyTo: "<u1@mail.client.com>" } } });
    expect(by.important!.attention?.priority).toBeGreaterThan(by.unread!.attention!.priority);
    expect(by.readPlain!.data).toMatchObject({ unread: false, awaiting: true });
    expect(by.readPlain!.attention).toBeUndefined();
    for (const id of ["sentLast", "selfLast", "invite", "calNotify"]) {
      expect(by[id]!.data.awaiting, id).toBe(false);
      expect(by[id]!.attention, id).toBeUndefined();
    }
    expect(s.coverage.scopes[0]!.note).toMatch(/2 thread\(s\) outside the 7-day window or undated/);
    expect(s.coverage.scopes[0]!.state).toBe("complete");
  });

  it("calendar notification markers are case-insensitive on subject and sender", () => {
    expect(isCalendarNotification("ACCEPTED: Weekly", "x@y.com")).toBe(true);
    expect(isCalendarNotification("Updated invitation with note: Q4", "x@y.com")).toBe(true);
    expect(isCalendarNotification("New time proposed: Lunch", "x@y.com")).toBe(true);
    expect(isCalendarNotification("Hello", "Calendar <CALENDAR-NOTIFICATION@google.com>")).toBe(true);
    expect(isCalendarNotification("Declining the offer", "x@y.com")).toBe(false);
  });

  it("fingerprint depends on the last message and awaiting state, not historyId", async () => {
    threads({ a: [{ id: "a1", labels: ["UNREAD"] }] });
    const one = (await gmailAdapter.sync!(ctx())).observations[0]!.fingerprintParts;
    const two = (await gmailAdapter.sync!(ctx())).observations[0]!.fingerprintParts;
    expect(one).toEqual(two);
    expect(one).toEqual(["a1", true]);
  });

  it("gmail.draft is denied without the compose scope and makes no request", async () => {
    const action = { kind: "gmail.draft", target: { threadId: "abc", to: "mia@client.com", subject: "Budget", inReplyTo: "<m@x>" }, payload: { body: "Thanks" }, effectKey: "e1" };
    await expect(gmailAdapter.execute!(ctx(), action)).rejects.toMatchObject({ state: "denied", message: expect.stringMatching(/gmail\.compose/) });
    expect(fx.requests).toHaveLength(0);
  });

  it("gmail.draft: creates once with the effect header, verifies by read-back, recovery finds it", async () => {
    const drafts: Array<{ id: string; message: { id: string; threadId: string; headers: Array<{ name: string; value: string }> } }> = [
      { id: "d-other", message: { id: "m-other", threadId: "zzz", headers: [] } },
    ];
    let raw = "";
    fx.route("POST", `${API}/drafts`, (req) => {
      const b = req.body as { message: { raw: string; threadId: string } };
      raw = Buffer.from(b.message.raw, "base64url").toString("utf8");
      const headers = raw.split("\r\n\r\n")[0]!.split("\r\n").map((l) => ({ name: l.slice(0, l.indexOf(":")), value: l.slice(l.indexOf(":") + 1).trim() }));
      const d = { id: `d${drafts.length}`, message: { id: `m${drafts.length}`, threadId: b.message.threadId, headers } };
      drafts.push(d);
      return { json: { id: d.id, message: { id: d.message.id, threadId: d.message.threadId } } };
    });
    const asApi = (d: (typeof drafts)[number]) => ({ id: d.id, message: { id: d.message.id, threadId: d.message.threadId, payload: { headers: d.message.headers } } });
    fx.route("GET", new RegExp(`^${API}/drafts/[^/]+$`), (req) => ({ json: asApi(drafts.find((d) => d.id === req.path.split("/").pop())!) }));
    fx.route("GET", `${API}/drafts`, () => ({ json: { drafts: drafts.map((d) => ({ id: d.id, message: { id: d.message.id, threadId: d.message.threadId } })) } }));
    fx.route("GET", new RegExp(`^${API}/messages/[^/]+$`), (req) => ({ json: asApi(drafts.find((d) => d.message.id === req.path.split("/").pop())!).message }));
    const action = { kind: "gmail.draft", target: { threadId: "abc", to: "Mia <mia@client.com>", subject: "Budget", inReplyTo: "<m1@x>", references: "<m0@x> <m1@x>" }, payload: { body: "Thanks, Mia" }, effectKey: "eff-g" };
    const c = () => ctx({ granted: `${GMAIL_READ_SCOPE} ${GMAIL_COMPOSE_SCOPE}` });
    const r = await gmailAdapter.execute!(c(), action);
    expect(r).toMatchObject({ verified: true, remoteId: "d1" });
    expect(raw).toContain("To: Mia <mia@client.com>\r\n");
    expect(raw).toContain("Subject: Re: Budget\r\n");
    expect(raw).toContain("In-Reply-To: <m1@x>\r\n");
    expect(raw).toContain("References: <m0@x> <m1@x>\r\n");
    expect(raw).toContain("X-Jarvis-Effect: eff-g\r\n");
    expect(Buffer.from(raw.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Thanks, Mia");
    expect((fx.requests.find((q) => q.method === "POST")!.body as { message: { threadId: string } }).message.threadId).toBe("abc");
    expect(await gmailAdapter.findEffect!(c(), action)).toMatchObject({ verified: true, remoteId: "d1" });
    expect(await gmailAdapter.findEffect!(c(), { ...action, effectKey: "other" })).toBeNull();
    expect(fx.requests.filter((q) => q.method === "POST" && q.path.startsWith(API))).toHaveLength(1);
  });

  it("gmail.draft rejects header injection in the recipient", async () => {
    const action = { kind: "gmail.draft", target: { threadId: "abc", to: "mia@client.com\r\nBcc: evil@x.com", subject: "Hi" }, payload: { body: "x" }, effectKey: "e" };
    await expect(gmailAdapter.execute!(ctx({ granted: GMAIL_COMPOSE_SCOPE }), action)).rejects.toThrow(/Invalid To/);
  });

  it("OAuth: authorize URL uses PKCE/offline consent, and code exchange stores tokens and granted scopes", async () => {
    const c = ctx({ secrets: { clientSecret: "GOCSPX-testsecret" } });
    const url = new URL(await gmailAdapter.authorizeUrl!(c, { redirectUri: "http://127.0.0.1:4700/cb", state: "st8", codeChallenge: "chal", scopes: [] }));
    expect(url.pathname).toBe("/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: CLIENT_ID, response_type: "code", access_type: "offline", prompt: "consent", include_granted_scopes: "true", code_challenge_method: "S256", code_challenge: "chal", state: "st8", redirect_uri: "http://127.0.0.1:4700/cb", scope: GMAIL_READ_SCOPE });
    tokenRoute((f) => (f.grant_type === "authorization_code" && f.code === "the-code" && f.code_verifier === "verifier" ? { json: { access_token: "ya29.new", refresh_token: "1//new-refresh", expires_in: 3600, scope: `${GMAIL_READ_SCOPE} openid` } } : { status: 400, json: { error: "invalid_grant" } }));
    fx.route("GET", `${API}/profile`, () => ({ json: { emailAddress: SELF } }));
    const done = await gmailAdapter.completeAuthorization!(c, { code: "the-code", redirectUri: "http://127.0.0.1:4700/cb", codeVerifier: "verifier" });
    expect(done).toMatchObject({ account: SELF, settings: { clientId: CLIENT_ID, grantedScopes: `${GMAIL_READ_SCOPE} openid` } });
    expect(c.secrets.get("refreshToken")).toBe("1//new-refresh");
    expect(c.secrets.get("accessToken")).toBe("ya29.new");
    await expect(gmailAdapter.completeAuthorization!(c, { code: "bad", redirectUri: "x", codeVerifier: "v" })).rejects.toMatchObject({ state: "unauthorized" });
  });

  it("configure stores the client secret as a secret and the client ID as a setting", async () => {
    const c = ctx({ secrets: {} });
    const settings = await gmailAdapter.configure(c, { clientId: CLIENT_ID, clientSecret: "GOCSPX-abc" });
    expect(settings).toMatchObject({ clientId: CLIENT_ID, authMethod: "oauth" });
    expect(JSON.stringify(settings)).not.toContain("GOCSPX");
    expect(c.secrets.get("clientSecret")).toBe("GOCSPX-abc");
  });
});
