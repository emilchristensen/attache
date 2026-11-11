import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { jiraAdapter, dueCategory, normalizeIssue } from "../../src/connectors/jira.ts";
import { ATLASSIAN_MCP_BASE } from "../../src/connectors/atlassian.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { fixtureContext } from "../fixtures/adapter-harness.ts";
import { MCP_PREFIX, ToolError, executeOps, mountAtlassianMcp, type AtlassianFixture } from "../fixtures/atlassian-mcp.ts";

let fx: FixtureServer;
let atl: AtlassianFixture;
beforeAll(async () => {
  fx = await startFixtureServer();
  process.env.JARVIS_TEST_ENDPOINTS = "1";
});
afterAll(async () => {
  delete process.env.JARVIS_TEST_ENDPOINTS;
  await fx.close();
});

const SITE = "https://acme.atlassian.net";
const TOKEN = "ATATT3xFfGF0testtokentesttoken";

const issue = (key: string, extra: { duedate?: string | null; status?: string; summary?: string; priority?: string } = {}) => ({
  key,
  fields: {
    summary: extra.summary ?? `Work ${key}`,
    status: { name: extra.status ?? "In Progress", statusCategory: { key: "indeterminate" } },
    duedate: extra.duedate ?? null,
    priority: { name: extra.priority ?? "Medium" },
    assignee: { displayName: "Alex" },
    project: { key: key.split("-")[0] },
  },
});

function identity() {
  atl.tools.set("atlassianUserInfo", () => ({ account_id: "acc-alex", email: "alex@acme.com", name: "Alex" }));
  atl.tools.set("getAccessibleAtlassianResources", () => [{ id: "cloud-1", url: SITE, name: "Acme", scopes: ["read:jira-work"] }]);
}

beforeEach(() => {
  fx.reset();
  atl = mountAtlassianMcp(fx);
  atl.apiTokens.add(`alex@acme.com:${TOKEN}`);
  identity();
});

const ctx = (scopes = ["assigned_open"], opts: { secrets?: Record<string, string>; settings?: Record<string, unknown> } = {}) => {
  const c = fixtureContext({ kind: "jira", baseUrl: fx.url, secrets: opts.secrets ?? { apiToken: TOKEN }, settings: opts.settings ?? { siteUrl: SITE, email: "alex@acme.com", authMethod: "api-token", cloudId: "cloud-1" }, readScopes: scopes, now: new Date("2026-09-30T10:00:00") });
  c.endpoint = (d) => (d === ATLASSIAN_MCP_BASE ? `${fx.url}${MCP_PREFIX}` : d);
  return c;
};

const searches = () => atl.calls.filter((c) => c.name === "searchJiraIssuesUsingJql");

describe("Jira adapter contract (Atlassian Rovo MCP server)", () => {
  it("authorization: API token is sent as Basic auth; test resolves the site to its cloud id", async () => {
    atl.tools.set("searchJiraIssuesUsingJql", () => ({ issues: [], isLast: true }));
    const r = await jiraAdapter.test(ctx(["assigned_open"], { settings: { siteUrl: SITE, email: "alex@acme.com", authMethod: "api-token" } }));
    expect(r).toMatchObject({ ok: true, state: "complete", account: "alex@acme.com", settings: { cloudId: "cloud-1" } });
    expect(searches()[0]!.args.cloudId).toBe("cloud-1");
  });

  it("authorization: a wrong token is unauthorized; a token without MCP scopes explains how to fix it", async () => {
    expect(await jiraAdapter.test(ctx(["assigned_open"], { secrets: { apiToken: "wrong" } }))).toMatchObject({ ok: false, state: "unauthorized" });
    atl.tools.set("atlassianUserInfo", () => {
      throw new ToolError('Unable to resolve user scopes from the user-context token for "atlassianUserInfo". The session token is missing the scope claim required to authorize this operation.', 401);
    });
    const r = await jiraAdapter.test(ctx());
    expect(r).toMatchObject({ ok: false, state: "unauthorized" });
    expect(r.message).toMatch(/mcp-v2/);
  });

  it("authorization: a site the account cannot reach is denied, naming the reachable sites", async () => {
    atl.tools.set("getAccessibleAtlassianResources", () => [{ id: "cloud-2", url: "https://other.atlassian.net" }]);
    const r = await jiraAdapter.test(ctx());
    expect(r).toMatchObject({ ok: false, state: "denied" });
    expect(r.message).toContain("https://other.atlassian.net");
  });

  it("authorization: OAuth 2.1 discovery, dynamic registration, PKCE code exchange, then Bearer calls with refresh", async () => {
    const c = ctx(["assigned_open"], { secrets: {}, settings: { siteUrl: SITE, authMethod: "oauth" } });
    expect(await jiraAdapter.isAuthorized!(c)).toBe(false);
    const redirectUri = "http://127.0.0.1:4317/api/v1/oauth/callback";
    const verifier = "v".repeat(48);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const { url, settings } = await jiraAdapter.authorizeUrl!(c, { redirectUri, state: "st-1", codeChallenge: challenge, scopes: jiraAdapter.oauthScopes!(false) });
    const u = new URL(url);
    expect(u.searchParams.get("scope")).toContain("read:jira:agent-interface");
    expect(u.searchParams.get("scope")).toContain("offline_access");
    expect(u.searchParams.get("scope")).not.toContain("write:jira");
    expect(u.searchParams.get("resource")).toBe(`${fx.url}${MCP_PREFIX}/v2/mcp`);
    c.connection.settings = { ...c.connection.settings, ...settings };
    const res = await fetch(url, { redirect: "manual" });
    const back = new URL(res.headers.get("location")!);
    expect(back.searchParams.get("state")).toBe("st-1");
    // A wrong verifier is rejected: PKCE is enforced.
    await expect(jiraAdapter.completeAuthorization!(c, { code: back.searchParams.get("code")!, redirectUri, codeVerifier: "x".repeat(48) })).rejects.toMatchObject({ state: "unauthorized" });
    const res2 = await fetch(url, { redirect: "manual" });
    const code = new URL(res2.headers.get("location")!).searchParams.get("code")!;
    const done = await jiraAdapter.completeAuthorization!(c, { code, redirectUri, codeVerifier: verifier });
    c.connection.settings = done.settings;
    expect(await jiraAdapter.isAuthorized!(c)).toBe(true);
    atl.tools.set("searchJiraIssuesUsingJql", () => ({ issues: [issue("ABC-1")], isLast: true }));
    expect((await jiraAdapter.refresh!(c)).coverage.state).toBe("complete");
    // The server forgets the access token: one refresh, then the call succeeds.
    atl.accessTokens.clear();
    expect((await jiraAdapter.refresh!(c)).coverage.state).toBe("complete");
    // Two jobs on the same connection with an expired token: one refresh, both succeed (refresh tokens are single use).
    atl.accessTokens.clear();
    c.secrets.set("accessTokenExpiresAt", new Date(0).toISOString());
    const twin = { ...c };
    const [x, y] = await Promise.all([jiraAdapter.refresh!(c), jiraAdapter.refresh!(twin)]);
    expect([x.coverage.state, y.coverage.state]).toEqual(["complete", "complete"]);
    // The refresh token is revoked too: the sync is unauthorized, never "empty".
    atl.accessTokens.clear();
    atl.refreshTokens.clear();
    expect((await jiraAdapter.refresh!(c)).coverage.state).toBe("unauthorized");
  });

  it("scope: only selected scopes are queried, with the scope's own JQL", async () => {
    atl.tools.set("searchJiraIssuesUsingJql", () => ({ issues: [], isLast: true }));
    await jiraAdapter.refresh!(ctx(["due_soon"]));
    expect(searches()).toHaveLength(1);
    expect(searches()[0]!.args.jql).toContain("duedate <= 7d");
    atl.calls.length = 0;
    await jiraAdapter.refresh!(ctx(["assigned_open", "reported_open"]));
    expect(searches().map((s) => String(s.args.jql).split(" ")[0]).sort()).toEqual(["assignee", "reporter"]);
  });

  it("pagination: follows nextPageToken until isLast; a page cap is partial", async () => {
    atl.tools.set("searchJiraIssuesUsingJql", (args) => {
      const page = Number(args.nextPageToken ?? 0);
      return { issues: [issue(`ABC-${page + 1}`)], isLast: page === 2, nextPageToken: String(page + 1) };
    });
    const r = await jiraAdapter.refresh!(ctx());
    expect(r.observations.map((o) => o.externalId)).toEqual(["ABC-1", "ABC-2", "ABC-3"]);
    expect(r.coverage).toMatchObject({ state: "complete", items: 3 });
    atl.tools.set("searchJiraIssuesUsingJql", (args) => ({ issues: [issue(`ABC-${Number(args.nextPageToken ?? 0) + 1}`)], isLast: false, nextPageToken: String(Number(args.nextPageToken ?? 0) + 1) }));
    const capped = await jiraAdapter.refresh!(ctx());
    expect(capped.coverage.state).toBe("partial");
    expect(capped.coverage.scopes[0]!.note).toMatch(/Stopped after 5 pages/);
  });

  it("pagination: a next-page token without isLast is followed, not treated as the last page", async () => {
    atl.tools.set("searchJiraIssuesUsingJql", (args) => (args.nextPageToken ? { issues: [issue("ABC-2")] } : { issues: [issue("ABC-1")], nextPageToken: "p2" }));
    const r = await jiraAdapter.refresh!(ctx());
    expect(r.observations.map((o) => o.externalId)).toEqual(["ABC-1", "ABC-2"]);
    expect(r.coverage.state).toBe("complete");
  });

  it("retry: HTTP 429 and 5xx on reads are retried; a failure after the first page keeps what was read as partial", async () => {
    let calls = 0;
    atl.tools.set("searchJiraIssuesUsingJql", (args) => {
      calls++;
      if (args.nextPageToken === "2") throw new ToolError("Rate limit exceeded", 429);
      return { issues: [issue(`ABC-${calls}`)], isLast: false, nextPageToken: "2" };
    });
    atl.failNext = [429, 503];
    const r = await jiraAdapter.refresh!(ctx());
    expect(atl.failNext).toEqual([]);
    expect(r.coverage.state).toBe("partial");
    expect(r.observations).toHaveLength(1);
    expect(r.coverage.scopes[0]!.note).toMatch(/Rate limit/);
    // Persistent 5xx is offline, not empty.
    atl.failNext = [503, 503, 503];
    expect((await jiraAdapter.refresh!(ctx())).coverage.state).toBe("offline");
  });

  it("empty results: a successful zero is empty; an unreadable shape is an error, never empty", async () => {
    atl.tools.set("searchJiraIssuesUsingJql", () => ({ issues: [], isLast: true }));
    expect((await jiraAdapter.refresh!(ctx())).coverage.state).toBe("empty");
    atl.tools.set("searchJiraIssuesUsingJql", () => ({ unexpected: true }));
    expect((await jiraAdapter.refresh!(ctx())).coverage.state).toBe("error");
    atl.tools.set("searchJiraIssuesUsingJql", () => ({ issues: [issue("ABC-1"), { nokey: true }], isLast: true }));
    const partial = await jiraAdapter.refresh!(ctx());
    expect(partial.coverage.state).toBe("partial");
    expect(partial.coverage.scopes[0]!.note).toMatch(/1 result\(s\) had no readable/);
  });

  it("partial coverage: one scope denied while another succeeds is partial, with the denial noted", async () => {
    atl.tools.set("searchJiraIssuesUsingJql", (args) => {
      if (String(args.jql).startsWith("reporter")) throw new ToolError("You do not have permission to browse this project", 403);
      return { issues: [issue("ABC-1")], isLast: true };
    });
    const r = await jiraAdapter.refresh!(ctx(["assigned_open", "reported_open"]));
    expect(r.coverage.state).toBe("partial");
    expect(r.coverage.scopes.find((s) => s.state === "denied")).toBeTruthy();
  });

  it("transport: SSE answers and a dropped MCP session (re-initialize once) both work", async () => {
    atl.tools.set("searchJiraIssuesUsingJql", () => ({ issues: [issue("ABC-1")], isLast: true }));
    atl.sse = true;
    const c = ctx();
    expect((await jiraAdapter.refresh!(c)).coverage.state).toBe("complete");
    atl.dropSessions = true;
    expect((await jiraAdapter.refresh!(c)).coverage.state).toBe("complete");
  });

  it("attention: due and overdue items, with priority boost; unrelated fields do not change the fingerprint", async () => {
    atl.tools.set("searchJiraIssuesUsingJql", () => ({ issues: [issue("ABC-1", { duedate: "2026-09-29", priority: "High" }), issue("ABC-2", { duedate: "2026-10-02" }), issue("ABC-3", { duedate: "2026-12-01" })], isLast: true }));
    const r = await jiraAdapter.refresh!(ctx());
    const att = r.observations.filter((o) => o.attention).map((o) => [o.attention!.key, o.attention!.kind, o.attention!.priority]);
    expect(att).toEqual([["jira:ABC-1", "overdue_work_item", 90], ["jira:ABC-2", "due_work_item", 62]]);
    expect(r.observations[0]!.url).toBe(`${SITE}/browse/ABC-1`);
  });

  it("execute: posts the comment once (no retry), verifies it by reading it back; recovery finds it by author and text", async () => {
    const comments: Array<Record<string, unknown>> = [];
    atl.tools.set("addOrEditJiraIssueComment", (args) => {
      const c = { id: String(10000 + comments.length), author: { accountId: "acc-alex" }, body: String(args.commentBody), created: "2026-09-30T10:00:00Z" };
      comments.push(c);
      return { commentId: c.id, body: c.body, appliedContentFormat: "markdown" };
    });
    executeOps(atl, { listJiraIssueComments: (inputs) => ({ comments: comments.filter(() => inputs.issueIdOrKey === "ABC-1"), total: comments.length, startAt: 0 }) });
    const action = { kind: "jira.comment", target: { key: "ABC-1" }, payload: { body: "Moving this to Thursday.\n\nWill update." }, effectKey: "eff-1" };
    const c = ctx(["assigned_open"]);
    c.connection.writeActions = ["jira.comment"];
    expect(await jiraAdapter.findEffect!(c, action)).toBeNull();
    const r = await jiraAdapter.execute!(c, action);
    expect(r).toMatchObject({ verified: true, remoteId: "10000", url: `${SITE}/browse/ABC-1?focusedCommentId=10000` });
    expect(atl.calls.filter((x) => x.name === "addOrEditJiraIssueComment")).toHaveLength(1);
    expect(atl.calls.find((x) => x.name === "addOrEditJiraIssueComment")!.args).toMatchObject({ cloudId: "cloud-1", issueIdOrKey: "ABC-1", contentFormat: "markdown" });
    expect(await jiraAdapter.findEffect!(c, action)).toMatchObject({ verified: true, remoteId: "10000" });
    // Someone else's identical text is not our effect.
    comments[0]!.author = { accountId: "acc-other" };
    expect(await jiraAdapter.findEffect!(c, action)).toBeNull();
  });

  it("recovery: Markdown read back as ADF still matches; older comments and an unknown account never do", async () => {
    const adf = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "Moving to " }, { type: "text", text: "Thursday", marks: [{ type: "strong" }] }] }] };
    const comments = [{ id: "7", author: { accountId: "acc-alex" }, body: adf, created: "2026-09-30T09:59:00.000+0000" }];
    executeOps(atl, { listJiraIssueComments: () => ({ comments, total: 1 }) });
    const action = { kind: "jira.comment", target: { key: "ABC-1" }, payload: { body: "Moving to **Thursday**" }, effectKey: "e" };
    expect(await jiraAdapter.findEffect!(ctx(), { ...action, since: "2026-09-30T10:00:00Z" })).toMatchObject({ verified: true, remoteId: "7" });
    expect(await jiraAdapter.findEffect!(ctx(), { ...action, since: "2026-09-30T11:00:00Z" })).toBeNull();
    atl.tools.set("atlassianUserInfo", () => ({ email: "alex@acme.com" }));
    await expect(jiraAdapter.findEffect!(ctx(), action)).rejects.toThrow(/identify your Atlassian account/);
  });

  it("execute: a write failing at the server is not retried and reports the error", async () => {
    let n = 0;
    atl.tools.set("addOrEditJiraIssueComment", () => {
      n++;
      throw new ToolError("Service unavailable", 503);
    });
    await expect(jiraAdapter.execute!(ctx(), { kind: "jira.comment", target: { key: "ABC-1" }, payload: { body: "x" }, effectKey: "e" })).rejects.toMatchObject({ state: "offline" });
    expect(n).toBe(1);
    await expect(jiraAdapter.execute!(ctx(), { kind: "jira.comment", target: { key: "not a key" }, payload: { body: "x" }, effectKey: "e" })).rejects.toThrow(/Invalid Jira/);
  });

  it("helpers: due categories by local date; compact issue rows normalise", () => {
    expect(dueCategory("2026-09-29", "2026-09-30")).toBe("overdue");
    expect(dueCategory("2026-10-07", "2026-09-30")).toBe("due");
    expect(dueCategory("2026-10-08", "2026-09-30")).toBe("open");
    expect(normalizeIssue({ key: "ABC-7", summary: "Flat", status: "Done", priority: "Low", duedate: null })).toMatchObject({ key: "ABC-7", status: "Done", priority: "Low" });
    expect(normalizeIssue({ summary: "no key" })).toBeNull();
  });
});
