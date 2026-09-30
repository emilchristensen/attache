import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { jiraAdapter, dueCategory, toAdf } from "../../src/connectors/jira.ts";
import { startFixtureServer, type FixtureServer, type FixtureRequest } from "../fixtures/fixture-server.ts";
import { fixtureContext } from "../fixtures/adapter-harness.ts";

let fx: FixtureServer;
beforeAll(async () => {
  fx = await startFixtureServer();
});
afterAll(() => fx.close());
beforeEach(() => fx.reset());

const TOKEN = "ATATT3xFfGF0testtokentesttoken";
const EXPECTED_AUTH = `Basic ${Buffer.from(`alex@acme.com:${TOKEN}`).toString("base64")}`;
const SEARCH = "/rest/api/3/search/jql";

const issue = (key: string, extra: { duedate?: string | null; status?: string; summary?: string; priority?: string; updated?: string } = {}) => ({
  key,
  fields: {
    summary: extra.summary ?? `Work ${key}`,
    status: { name: extra.status ?? "In Progress", statusCategory: { key: "indeterminate" } },
    duedate: extra.duedate ?? null,
    priority: { name: extra.priority ?? "Medium" },
    assignee: { displayName: "Alex" },
    project: { key: key.split("-")[0] },
    updated: extra.updated ?? "2026-09-29T10:00:00.000+0000",
  },
});

const ctx = (scopes = ["assigned_open"], secrets: Record<string, string> = { apiToken: TOKEN }) =>
  fixtureContext({ kind: "jira", baseUrl: fx.url, secrets, settings: { siteUrl: "https://acme.atlassian.net", email: "alex@acme.com" }, readScopes: scopes });

const jqlOf = (r: FixtureRequest) => r.query.get("jql") ?? "";
const searches = () => fx.requests.filter((r) => r.path === SEARCH);

describe("Jira adapter contract", () => {
  it("authorization: sends Basic email:token and reports the account", async () => {
    fx.route("GET", "/rest/api/3/myself", (req) => (req.headers.authorization === EXPECTED_AUTH ? { json: { displayName: "Alex", emailAddress: "alex@acme.com" } } : { status: 401, json: {} }));
    expect(await jiraAdapter.test(ctx())).toMatchObject({ ok: true, state: "complete", account: "alex@acme.com" });
  });

  it("authorization failure is 'unauthorized' for test and sync", async () => {
    fx.route("GET", "/rest/api/3/myself", () => ({ status: 401, json: {} }));
    fx.route("GET", SEARCH, () => ({ status: 401, json: {} }));
    expect((await jiraAdapter.test(ctx())).state).toBe("unauthorized");
    const s = await jiraAdapter.sync!(ctx());
    expect(s.coverage.state).toBe("unauthorized");
    expect(s.observations).toHaveLength(0);
  });

  it("configure stores only the token as a secret and validates the site URL", async () => {
    const c = ctx([], {});
    const settings = await jiraAdapter.configure(c, { siteUrl: "https://acme.atlassian.net/", email: "alex@acme.com", apiToken: TOKEN });
    expect(settings).toEqual({ siteUrl: "https://acme.atlassian.net", email: "alex@acme.com", authMethod: "api-token" });
    expect(c.secrets.get("apiToken")).toBe(TOKEN);
    await expect(jiraAdapter.configure(c, { siteUrl: "http://acme.atlassian.net", email: "alex@acme.com", apiToken: TOKEN })).rejects.toThrow(/https/);
  });

  it("scope: only selected scopes are queried; a 403 scope is 'denied'", async () => {
    fx.route("GET", SEARCH, (req) => (jqlOf(req).startsWith("reporter") ? { status: 403, json: { errorMessages: ["no"] } } : { json: { issues: [], isLast: true } }));
    const s = await jiraAdapter.sync!(ctx(["assigned_open", "reported_open"]));
    const jqls = searches().map(jqlOf);
    expect(jqls).toHaveLength(2);
    expect(jqls.some((q) => q.includes("duedate <= 7d"))).toBe(false);
    expect(jqls[0]).toBe("assignee = currentUser() AND statusCategory != Done ORDER BY duedate ASC");
    expect(s.coverage.scopes.find((c) => c.scope.includes("reported"))!.state).toBe("denied");
    expect(s.coverage.state).toBe("partial");
  });

  it("pagination: follows nextPageToken until isLast, requesting the needed fields", async () => {
    fx.route("GET", SEARCH, (req) => (req.query.get("nextPageToken") === "p2" ? { json: { issues: [issue("ABC-3")], isLast: true } } : { json: { issues: [issue("ABC-1"), issue("ABC-2")], nextPageToken: "p2", isLast: false } }));
    const s = await jiraAdapter.sync!(ctx());
    expect(s.observations.map((o) => o.externalId)).toEqual(["ABC-1", "ABC-2", "ABC-3"]);
    expect(s.coverage).toMatchObject({ state: "complete", items: 3 });
    expect(s.coverage.scopes[0]).toMatchObject({ pages: 2, items: 3 });
    expect(searches()[0]!.query.get("fields")).toBe("summary,status,duedate,priority,assignee,project");
  });

  it("retry: retries 429 honouring Retry-After, then succeeds", async () => {
    let calls = 0;
    fx.route("GET", SEARCH, () => (++calls < 2 ? { status: 429, headers: { "retry-after": "0" }, json: {} } : { json: { issues: [], isLast: true } }));
    const s = await jiraAdapter.sync!(ctx());
    expect(calls).toBe(2);
    expect(s.coverage.state).toBe("empty");
  });

  it("empty result: a successful zero is 'empty'", async () => {
    fx.route("GET", SEARCH, () => ({ json: { issues: [], isLast: true } }));
    const s = await jiraAdapter.sync!(ctx());
    expect(s.coverage.scopes[0]).toMatchObject({ state: "empty", items: 0, pages: 1 });
  });

  it("partial coverage: mid-pagination failure and the page cap are partial", async () => {
    fx.route("GET", SEARCH, (req) => (req.query.get("nextPageToken") ? { status: 503, json: {} } : { json: { issues: [issue("ABC-1")], nextPageToken: "p2", isLast: false } }));
    const a = await jiraAdapter.sync!(ctx());
    expect(a.coverage.state).toBe("partial");
    expect(a.observations).toHaveLength(1);
    fx.reset();
    let n = 0;
    fx.route("GET", SEARCH, () => ({ json: { issues: [issue(`ABC-${++n}`)], nextPageToken: `p${n + 1}`, isLast: false } }));
    const b = await jiraAdapter.sync!(ctx());
    expect(b.coverage.scopes[0]).toMatchObject({ state: "partial", pages: 5 });
    expect(b.coverage.scopes[0]!.note).toMatch(/5 pages/);
  });

  it("disconnect: without a stored token no request is made", async () => {
    const s = await jiraAdapter.sync!(ctx(["assigned_open"], {}));
    expect(s.coverage.state).toBe("unauthorized");
    expect(fx.requests).toHaveLength(0);
  });

  it("dedupes issues across scopes by key, first scope wins", async () => {
    fx.route("GET", SEARCH, () => ({ json: { issues: [issue("ABC-1", { duedate: "2026-10-02" })], isLast: true } }));
    const s = await jiraAdapter.sync!(ctx(["assigned_open", "due_soon", "reported_open"]));
    expect(s.observations).toHaveLength(1);
    expect(s.observations[0]!.attention?.key).toBe("jira:ABC-1");
  });

  it("due → overdue is a change of the same key; an updated-only change keeps the fingerprint", async () => {
    let now = new Date("2026-09-30T10:00:00Z");
    let updated = "2026-09-29T10:00:00.000+0000";
    fx.route("GET", SEARCH, () => ({ json: { issues: [issue("ABC-1", { duedate: "2026-10-01", updated, summary: "Ship it" })], isLast: true } }));
    const run = async () => {
      const c = ctx();
      c.now = () => now;
      return (await jiraAdapter.sync!(c)).observations[0]!;
    };
    const due = await run();
    updated = "2026-09-30T09:00:00.000+0000";
    const touched = await run();
    now = new Date("2026-10-02T10:00:00Z");
    const overdue = await run();
    expect(due.attention).toMatchObject({ key: "jira:ABC-1", kind: "due_work_item", extraFingerprint: ["due"] });
    expect(touched.fingerprintParts).toEqual(due.fingerprintParts);
    expect(overdue.attention).toMatchObject({ key: "jira:ABC-1", kind: "overdue_work_item", title: "ABC-1 overdue: Ship it", extraFingerprint: ["overdue"] });
    expect(overdue.fingerprintParts).not.toEqual(due.fingerprintParts);
    expect(overdue.attention!.priority).toBeGreaterThan(due.attention!.priority);
    expect(overdue.attention!.draftable).toMatchObject({ actionKind: "jira.comment", target: { key: "ABC-1" } });
  });

  it("no attention for items without a near due date, or for reported-only items", async () => {
    fx.route("GET", SEARCH, (req) => ({ json: { issues: [jqlOf(req).startsWith("reporter") ? issue("OPS-9", { duedate: "2026-09-01" }) : issue("ABC-1", { duedate: "2026-12-01" })], isLast: true } }));
    const s = await jiraAdapter.sync!(ctx(["assigned_open", "reported_open"]));
    expect(s.observations.map((o) => o.externalId)).toEqual(["ABC-1", "OPS-9"]);
    expect(s.observations.every((o) => !o.attention)).toBe(true);
    expect(dueCategory("2026-10-07", "2026-09-30")).toBe("due");
    expect(dueCategory("2026-10-08", "2026-09-30")).toBe("open");
    expect(dueCategory(null, "2026-09-30")).toBe("open");
  });

  it("write: posts once with an ADF body and property marker, verifies by read-back, recovery pages by startAt", async () => {
    const posted: Array<{ id: string; properties: Array<{ key: string; value: unknown }> }> = [{ id: "1", properties: [] }, { id: "2", properties: [] }];
    let bodySeen: unknown = null;
    fx.route("POST", "/rest/api/3/issue/ABC-1/comment", (req) => {
      const b = req.body as { body: unknown; properties: Array<{ key: string; value: unknown }> };
      bodySeen = b.body;
      const c = { id: String(100 + posted.length), properties: b.properties };
      posted.push(c);
      return { status: 201, json: { id: c.id } };
    });
    fx.route("GET", /^\/rest\/api\/3\/issue\/ABC-1\/comment\/\d+$/, (req) => (req.query.get("expand") === "properties" ? { json: posted.find((p) => p.id === req.path.split("/").pop()) } : { json: {} }));
    fx.route("GET", "/rest/api/3/issue/ABC-1/comment", (req) => {
      const startAt = Number(req.query.get("startAt"));
      return { json: { comments: posted.slice(startAt, startAt + 2), startAt, maxResults: 2, total: posted.length } };
    });
    const action = { kind: "jira.comment", target: { key: "ABC-1" }, payload: { body: "On it.\nThanks" }, effectKey: "eff-9" };
    const r = await jiraAdapter.execute!(ctx(), action);
    expect(r).toMatchObject({ verified: true, remoteId: "102" });
    expect(bodySeen).toEqual(toAdf("On it.\nThanks"));
    expect(bodySeen).toMatchObject({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "On it." }, { type: "hardBreak" }, { type: "text", text: "Thanks" }] }] });
    const found = await jiraAdapter.findEffect!(ctx(), action);
    expect(found).toMatchObject({ verified: true, remoteId: "102" });
    const startAts = fx.requests.filter((q) => q.path === "/rest/api/3/issue/ABC-1/comment" && q.method === "GET").map((q) => q.query.get("startAt"));
    expect(startAts).toEqual(["0", "2"]);
    expect(await jiraAdapter.findEffect!(ctx(), { ...action, effectKey: "other" })).toBeNull();
    expect(fx.requests.filter((q) => q.method === "POST")).toHaveLength(1);
  });

  it("write: rejects an invalid work item key without calling Jira", async () => {
    await expect(jiraAdapter.execute!(ctx(), { kind: "jira.comment", target: { key: "../../x" }, payload: { body: "hi" }, effectKey: "e" })).rejects.toThrow(/Invalid/);
    expect(fx.requests).toHaveLength(0);
  });
});
