import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { jiraAdapter } from "../../src/connectors/jira.ts";
import { confluenceAdapter } from "../../src/connectors/confluence.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { fixtureContext } from "../fixtures/adapter-harness.ts";
import { jsonAnswer, mountClaude, onTool, useFakeClaude, type ClaudeFixture } from "../fixtures/claude-connectors.ts";

// Each test starts many fake Claude Code processes one after another, which is slow while other suites share the machine.
vi.setConfig({ testTimeout: 120_000 });

// Shapes mirror what the claude.ai Atlassian Rovo connector (Rovo MCP v1) returned live on 2026-10-01.
let fx: FixtureServer;
let claude: ClaudeFixture;
const SERVER = "claude.ai Atlassian Rovo";
const SITE = "https://acme.atlassian.net";
const CLOUD = "cloud-acme";
const ME = "acc-alex";

beforeAll(async () => {
  fx = await startFixtureServer();
  useFakeClaude(fx.url);
});
afterAll(() => fx.close());

const issue = (key: string, due: string | null = null) => ({ id: key.replace(/\D/g, ""), key, fields: { summary: `Work ${key}`, status: { name: "To Do", statusCategory: { key: "new" } }, duedate: due, priority: { name: "Medium" }, assignee: { accountId: ME, displayName: "Alex" }, project: { key: key.split("-")[0] } }, webUrl: `${SITE}/browse/${key}` });
const page = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, type: "page", status: "current", title, lastModified: "about 2 hours ago", summary: `${title} summary`, space: { key: "ENG", name: "Engineering" }, _links: { webui: `/spaces/ENG/pages/${id}` }, author: { displayName: "Mia" }, ...extra });

beforeEach(() => {
  fx.reset();
  claude = mountClaude(fx, { servers: [{ name: SERVER, status: "connected", source: "claudeai" }] });
  onTool(claude, SERVER, "atlassianUserInfo", () => jsonAnswer({ account_id: ME, email: "alex@acme.com", name: "Alex" }));
  // One entry per product with the same id, as the live connector returns.
  onTool(claude, SERVER, "getAccessibleAtlassianResources", () => jsonAnswer([{ id: CLOUD, url: SITE, name: "acme", scopes: ["read:page:confluence"] }, { id: CLOUD, url: SITE, name: "acme", scopes: ["read:jira-work"] }]));
});

const ctx = (kind: "jira" | "confluence", scopes: string[], settings: Record<string, unknown> = {}) => fixtureContext({ kind, baseUrl: fx.url, settings: { siteUrl: SITE, authMethod: "claude-ai", transport: "mcp", cloudId: CLOUD, ...settings }, readScopes: scopes, now: new Date("2026-09-30T10:00:00") });
const calls = (tool: string) => claude.calls.filter((c) => c.tool === tool);

describe("Jira and Confluence through the claude.ai Atlassian Rovo connector", () => {
  it("configure needs no credential; test resolves the site to its cloud id through claude.ai", async () => {
    const settings = await jiraAdapter.configure(ctx("jira", []), { method: "claude-ai", siteUrl: "https://acme.atlassian.net/" });
    expect(settings).toMatchObject({ authMethod: "claude-ai", siteUrl: SITE, transport: "mcp" });
    expect(await jiraAdapter.isAuthorized!(ctx("jira", []))).toBe(true);
    onTool(claude, SERVER, "searchJiraIssuesUsingJql", () => jsonAnswer({ issues: { nodes: [], pageInfo: { hasNextPage: false } } }));
    const t = await jiraAdapter.test(ctx("jira", [], { cloudId: undefined }));
    expect(t).toMatchObject({ ok: true, account: "alex@acme.com", settings: { cloudId: CLOUD } });
    expect(t.message).toMatch(/through claude\.ai/);
    expect(calls("searchJiraIssuesUsingJql")[0]!.args.cloudId).toBe(CLOUD);
  });

  it("an unconnected Atlassian connector is unauthorized with the claude.ai fix, never empty", async () => {
    claude.servers = [{ name: SERVER, status: "needs-auth", source: "claudeai" }];
    expect(await jiraAdapter.test(ctx("jira", []))).toMatchObject({ ok: false, state: "unauthorized", message: expect.stringMatching(/claude\.ai → Settings → Connectors/) });
    expect((await confluenceAdapter.refresh!(ctx("confluence", ["mentions"]))).coverage.state).toBe("unauthorized");
  });

  it("Jira: follows pageInfo.endCursor as nextPageToken; every scope's first page shares one session", async () => {
    onTool(claude, SERVER, "searchJiraIssuesUsingJql", (a) => {
      if (String(a.jql).startsWith("reporter")) return jsonAnswer({ issues: { nodes: [issue("ABC-9")], pageInfo: { hasNextPage: false } } });
      return jsonAnswer(a.nextPageToken === "c2" ? { issues: { nodes: [issue("ABC-2", "2026-10-01")], pageInfo: { hasNextPage: false } } } : { issues: { nodes: [issue("ABC-1", "2026-09-29")], pageInfo: { hasNextPage: true, endCursor: "c2" } } });
    });
    const r = await jiraAdapter.refresh!(ctx("jira", ["assigned_open", "reported_open"]));
    expect(r.coverage.state).toBe("complete");
    expect(r.observations.map((o) => o.externalId).sort()).toEqual(["ABC-1", "ABC-2", "ABC-9"]);
    expect(r.observations.find((o) => o.externalId === "ABC-1")!.attention).toMatchObject({ kind: "overdue_work_item" });
    expect(claude.sessions).toBe(2);
  });

  it("Jira: hasNextPage without a cursor is partial, not complete", async () => {
    onTool(claude, SERVER, "searchJiraIssuesUsingJql", () => jsonAnswer({ issues: { nodes: [issue("ABC-1")], pageInfo: { hasNextPage: true } } }));
    const r = await jiraAdapter.refresh!(ctx("jira", ["assigned_open"]));
    expect(r.coverage.scopes[0]).toMatchObject({ state: "partial", items: 1, note: expect.stringMatching(/no usable cursor/) });
  });

  it("Confluence: a full page is partial (the connector gives no total); relative dates never become timestamps or fingerprint parts", async () => {
    onTool(claude, SERVER, "searchConfluenceUsingCql", (a) => jsonAnswer({ content: { totalCount: 1, nodes: [page("1001", "Q4 planning")], webUrl: "x" }, args: a }));
    const r = await confluenceAdapter.refresh!(ctx("confluence", ["mentions"]));
    expect(r.coverage.state).toBe("complete");
    const o = r.observations[0]!;
    expect(o).toMatchObject({ externalId: "1001", author: "Mia", url: `${SITE}/wiki/spaces/ENG/pages/1001`, attention: { key: "confluence:mention:1001" } });
    expect(o.occurredAt).toBeUndefined();
    expect(o.fingerprintParts).toEqual(["Q4 planning", "Q4 planning summary"]);
    expect(calls("searchConfluenceUsingCql")[0]!.args).toMatchObject({ cloudId: CLOUD, limit: 50 });
    onTool(claude, SERVER, "searchConfluenceUsingCql", () => jsonAnswer({ content: { totalCount: 50, nodes: Array.from({ length: 50 }, (_, i) => page(String(2000 + i), `P${i}`)) } }));
    const full = await confluenceAdapter.refresh!(ctx("confluence", ["mentions"]));
    expect(full.coverage.scopes[0]).toMatchObject({ state: "partial", items: 50, note: expect.stringMatching(/does not say whether more exist/) });
  });

  it("Jira comment: posted once through the gate, verified from the issue's comments; recovery by author, time and text", async () => {
    const comments: Array<Record<string, unknown>> = [];
    onTool(claude, SERVER, "addCommentToJiraIssue", (a) => {
      const c = { id: String(10000 + comments.length), author: { accountId: ME, displayName: "Alex" }, body: String(a.commentBody), created: "2026-09-30T10:00:30.000+0000" };
      comments.push(c);
      return jsonAnswer(c);
    });
    onTool(claude, SERVER, "getJiraIssue", () => jsonAnswer({ issues: { nodes: [{ key: "ABC-1", fields: { comment: { comments, total: comments.length, maxResults: 50, startAt: 0 } } }] } }));
    const action = { kind: "jira.comment", target: { key: "ABC-1" }, payload: { body: "Moving to **Thursday**" }, effectKey: "e1", since: "2026-09-30T10:00:00Z" };
    expect(await jiraAdapter.findEffect!(ctx("jira", []), action)).toBeNull();
    expect(await jiraAdapter.execute!(ctx("jira", []), action)).toMatchObject({ verified: true, remoteId: "10000", url: `${SITE}/browse/ABC-1?focusedCommentId=10000` });
    expect(calls("addCommentToJiraIssue")).toEqual([{ server: SERVER, tool: "addCommentToJiraIssue", args: { cloudId: CLOUD, issueIdOrKey: "ABC-1", commentBody: "Moving to **Thursday**", contentFormat: "markdown" } }]);
    expect(await jiraAdapter.findEffect!(ctx("jira", []), action)).toMatchObject({ verified: true, remoteId: "10000" });
  });

  it("Confluence comment: a footer comment in Markdown, verified from the page's footer comments", async () => {
    const comments: Array<Record<string, unknown>> = [];
    onTool(claude, SERVER, "createConfluenceFooterComment", (a) => {
      const c = { id: String(500 + comments.length), pageId: a.pageId, version: { authorId: ME, createdAt: "2026-09-30T10:00:20.000Z" }, body: { markdown: { value: String(a.body) } }, _links: { webui: `/spaces/ENG/pages/${String(a.pageId)}?focusedCommentId=${500 + comments.length}` } };
      comments.push(c);
      return jsonAnswer(c);
    });
    onTool(claude, SERVER, "getConfluencePageFooterComments", () => jsonAnswer({ results: comments, _links: { base: `${SITE}/wiki` } }));
    const action = { kind: "confluence.comment", target: { pageId: "1001" }, payload: { body: "Agreed" }, effectKey: "e2", since: "2026-09-30T10:00:00Z" };
    expect(await confluenceAdapter.execute!(ctx("confluence", []), action)).toMatchObject({ verified: true, remoteId: "500", url: `${SITE}/wiki/spaces/ENG/pages/1001?focusedCommentId=500` });
    expect(calls("createConfluenceFooterComment")[0]!.args).toEqual({ cloudId: CLOUD, pageId: "1001", body: "Agreed", contentFormat: "markdown" });
    expect(await confluenceAdapter.findEffect!(ctx("confluence", []), action)).toMatchObject({ verified: true, remoteId: "500" });
  });

  it("an error reported inside a result is classified, not read as zero items", async () => {
    onTool(claude, SERVER, "searchJiraIssuesUsingJql", () => jsonAnswer({ error: true, message: "You do not have permission to view these issues (403)" }));
    expect((await jiraAdapter.refresh!(ctx("jira", ["assigned_open"]))).coverage.state).toBe("denied");
  });
});
