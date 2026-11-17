/**
 * The two ways Attache reaches Jira and Confluence, behind one interface so
 * the adapters keep a single set of Source refresh, attention, coverage and recovery
 * rules:
 *
 * - "claude-ai" (default): the user's claude.ai Atlassian Rovo connector
 *   (Rovo MCP v1 tools) through the gated Claude Code session, like Slack,
 *   Gmail and Calendar. Works wherever the organization allows claude.ai.
 * - "oauth" / "api-token": Attache's own MCP client against the Rovo MCP v2
 *   endpoint (atlassian.ts), for organizations that allow other clients.
 *
 * Results are returned raw; the adapters normalise them.
 */
import type { AdapterContext } from "./types.ts";
import { RemoteError, paginate } from "./http.ts";
import { asRemoteError, stringSetting } from "./common.ts";
import { atlassianCall, atlassianExecute, accountOf, cloudId, CLAUDE_ATLASSIAN_SERVER, identifyAtlassian, resolveSite, siteUrl } from "./atlassian.ts";
import { callOne, outcomeText, paginateStreams, serverName, type Stream } from "./claude-adapter.ts";
import { commentsOf, pick, str } from "./atlassian-shapes.ts";

export interface Listing {
  items: unknown[];
  pages: number;
  complete: boolean;
  error: RemoteError | null;
  /** Why the listing is incomplete beyond page caps and errors (e.g. the source cannot say whether more exist). */
  notes: string[];
}

export interface Query {
  id: string;
  query: string;
}

export interface AtlassianBackend {
  identify(): Promise<{ account: string | null; cloudId: string; siteName: string | null }>;
  /** My Atlassian account id; throws when it cannot be read (recovery must never guess). */
  selfAccountId(): Promise<string>;
  searchJql(queries: Query[], opts?: { maxPages?: number; pageSize?: number }): Promise<Map<string, Listing>>;
  searchCql(queries: Query[], opts?: { maxPages?: number; pageSize?: number }): Promise<Map<string, Listing>>;
  addJiraComment(key: string, markdown: string): Promise<Record<string, unknown>>;
  listJiraComments(key: string): Promise<{ items: Array<Record<string, unknown>>; complete: boolean }>;
  addConfluenceComment(pageId: string, text: string, storageHtml: string): Promise<Record<string, unknown>>;
  listConfluenceComments(pageId: string): Promise<{ items: Array<Record<string, unknown>>; complete: boolean }>;
}

const FIELDS = ["summary", "status", "duedate", "priority", "assignee", "project"];
const DEFAULT_PAGES = 5;
const PAGE_SIZE = 50;

export function usesClaude(ctx: AdapterContext): boolean {
  return ctx.connection.settings.authMethod === "claude-ai";
}

export function atlassianBackend(ctx: AdapterContext): AtlassianBackend {
  return usesClaude(ctx) ? claudeBackend(ctx) : directBackend(ctx);
}

/** The cursor in a REST `_links.next` link. */
function linkCursor(res: unknown): string | null {
  const next = str(pick(res, "_links", "next"));
  if (!next) return null;
  try {
    return new URL(next, "https://x.invalid").searchParams.get("cursor");
  } catch {
    return null;
  }
}

// ---- Jira search pages: v2 returns {issues: [...], nextPageToken, isLast}; v1 {issues: {nodes, pageInfo}} ----

export function jiraPage(res: unknown): { items: unknown[]; next: string | null; stuck: boolean } {
  const issues = pick(res, "issues");
  if (Array.isArray(issues)) {
    const token = str(pick(res, "nextPageToken"));
    // Follow a token unless the page says it is the last one; a missing isLast is not "last".
    return { items: issues, next: pick(res, "isLast") !== true ? token : null, stuck: false };
  }
  const nodes = pick(issues, "nodes");
  if (!Array.isArray(nodes)) throw new RemoteError("Jira search returned an unexpected result shape", "error");
  const more = pick(issues, "pageInfo", "hasNextPage") === true;
  const cursor = str(pick(issues, "pageInfo", "endCursor"));
  return { items: nodes, next: more ? cursor : null, stuck: more && !cursor };
}

// ---- Confluence search pages: v2 {results, nextCursor | _links.next}; v1 {content: {nodes, totalCount, pageInfo?}} ----

export function confluencePage(res: unknown, pageSize: number): { items: unknown[]; next: string | null; stuck: boolean; uncounted: boolean } {
  const results = pick(res, "results");
  if (Array.isArray(results)) {
    const next = str(pick(res, "nextCursor")) ?? str(pick(res, "cursor")) ?? str(pick(res, "pagination", "nextCursor")) ?? linkCursor(res);
    return { items: results, next, stuck: !next && !!str(pick(res, "_links", "next")), uncounted: false };
  }
  const nodes = pick(res, "content", "nodes");
  if (!Array.isArray(nodes)) throw new RemoteError("Confluence search returned an unexpected result shape", "error");
  const more = pick(res, "content", "pageInfo", "hasNextPage") === true;
  const cursor = str(pick(res, "content", "pageInfo", "endCursor"));
  // This view states no total and no next page: a full page may hide more results.
  const uncounted = !more && nodes.length >= pageSize;
  return { items: nodes, next: more ? cursor : null, stuck: more && !cursor, uncounted };
}

function finishNotes(stuck: boolean, uncounted: boolean): string[] {
  return [...(stuck ? ["More results exist but the next page had no usable cursor"] : []), ...(uncounted ? ["Showing a full first page; the connector does not say whether more exist"] : [])];
}

// ---- direct: Attache's MCP client, Rovo MCP v2 -------------------------------------------------

function directBackend(ctx: AdapterContext): AtlassianBackend {
  const listing = async (q: Query, page: (cursor: string | null) => Promise<{ items: unknown[]; next: string | null; stuck: boolean; uncounted?: boolean }>, maxPages: number): Promise<Listing> => {
    let stuck = false;
    let uncounted = false;
    try {
      const r = await paginate<unknown>(
        async (cursor) => {
          const p = await page(cursor);
          stuck ||= p.stuck;
          uncounted ||= !!p.uncounted;
          return { items: p.items, next: p.next };
        },
        { maxPages },
      );
      return { items: r.items, pages: r.pages, complete: r.complete && !stuck && !uncounted, error: r.error, notes: finishNotes(stuck, uncounted) };
    } catch (e) {
      return { items: [], pages: 0, complete: false, error: asRemoteError(e), notes: [] };
    }
  };
  const all = async (queries: Query[], run: (q: Query) => Promise<Listing>) => new Map(await Promise.all(queries.map(async (q) => [q.id, await run(q)] as const)));
  return {
    identify: () => identifyAtlassian(ctx),
    async selfAccountId() {
      const me = await atlassianCall(ctx, "atlassianUserInfo", {});
      const id = str(pick(me, "account_id")) ?? str(pick(me, "accountId"));
      if (!id) throw new RemoteError("Could not identify your Atlassian account to check for an earlier attempt", "error");
      return id;
    },
    searchJql: (queries, opts = {}) => {
      const size = opts.pageSize ?? PAGE_SIZE;
      return all(queries, (q) => listing(q, async (cursor) => jiraPage(await atlassianCall(ctx, "searchJiraIssuesUsingJql", { cloudId: cloudId(ctx), jql: q.query, maxResults: size, fields: FIELDS, ...(cursor ? { nextPageToken: cursor } : {}) })), opts.maxPages ?? DEFAULT_PAGES));
    },
    searchCql: (queries, opts = {}) => {
      const size = opts.pageSize ?? PAGE_SIZE;
      return all(queries, (q) => listing(q, async (cursor) => confluencePage(await atlassianCall(ctx, "searchConfluence", { cloudId: cloudId(ctx), cql: q.query, limit: size, expand: "content.version,content.space", ...(cursor ? { cursor } : {}) }), size), opts.maxPages ?? DEFAULT_PAGES));
    },
    addJiraComment: (key, markdown) => atlassianCall(ctx, "addOrEditJiraIssueComment", { cloudId: cloudId(ctx), issueIdOrKey: key, commentBody: markdown, contentFormat: "markdown" }, { write: true }),
    async listJiraComments(key) {
      const r = await paginate<Record<string, unknown>>(
        async (cursor) => {
          const startAt = Number(cursor ?? 0);
          const { items, total } = commentsOf(await atlassianExecute(ctx, "listJiraIssueComments", { issueIdOrKey: key, startAt, maxResults: 100, orderBy: "-created" }));
          const nextAt = startAt + items.length;
          // Without a stated total, a full page means there may be more.
          const more = total !== null ? nextAt < total : items.length >= 100;
          return { items, next: items.length && more ? String(nextAt) : null };
        },
        { maxPages: 10 },
      );
      return { items: r.items, complete: r.complete };
    },
    addConfluenceComment: (pageId, _text, storageHtml) => atlassianExecute(ctx, "createConfluenceComment", { pageId, body: { representation: "storage", value: storageHtml } }, { write: true }),
    async listConfluenceComments(pageId) {
      const r = await paginate<Record<string, unknown>>(
        async (cursor) => {
          const res = await atlassianExecute<Record<string, unknown>>(ctx, "listConfluenceComments", { pageId, "body-format": "storage", limit: 100, ...(cursor ? { cursor } : {}) });
          return { items: commentsOf(res).items, next: confluencePage(res, 100).next };
        },
        { maxPages: 10 },
      );
      return { items: r.items, complete: r.complete };
    },
  };
}

// ---- claude.ai: the Atlassian Rovo connector through Claude Code, Rovo MCP v1 -----------------

function claudeBackend(ctx: AdapterContext): AtlassianBackend {
  const server = serverName(ctx, CLAUDE_ATLASSIAN_SERVER);
  const id = () => stringSetting(ctx.connection.settings, "cloudId") || siteUrl(ctx);
  const json = (text: string, what: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      throw new RemoteError(`${what} returned an unreadable result`, "error");
    }
  };
  /** A tool error the connector embeds in the result: {"error": true, "message": ...}. */
  const checked = (data: unknown, what: string): unknown => {
    if (data && typeof data === "object" && (data as { error?: unknown }).error !== undefined && (data as { error?: unknown }).error !== false) {
      const msg = str((data as { message?: unknown }).message) ?? JSON.stringify((data as { error?: unknown }).error);
      throw new RemoteError(`${what} failed: ${msg}`, /scope|unauthori[sz]ed|401/i.test(msg) ? "unauthorized" : /forbidden|permission|403/i.test(msg) ? "denied" : "error");
    }
    return data;
  };
  const call = async (tool: string, args: Record<string, unknown>, opts: { write?: boolean } = {}) => checked(json(await callOne(ctx, server, tool, args, opts), `Atlassian ${tool}`), `Atlassian ${tool}`);
  const search = async (queries: Query[], tool: string, args: (q: Query, cursor: string | null) => Record<string, unknown>, page: (res: unknown) => { items: unknown[]; next: string | null; stuck: boolean; uncounted?: boolean }, maxPages: number): Promise<Map<string, Listing>> => {
    const flags = new Map(queries.map((q) => [q.id, { stuck: false, uncounted: false }]));
    const streams: Array<Stream<unknown>> = queries.map((q) => ({
      id: q.id,
      label: q.id,
      maxPages,
      call: (cursor) => ({ tool, args: args(q, cursor) }),
      parse: (text) => {
        const p = page(checked(json(text, `Atlassian ${tool}`), `Atlassian ${tool}`));
        const f = flags.get(q.id)!;
        f.stuck ||= p.stuck;
        f.uncounted ||= !!p.uncounted;
        return { items: p.items, next: p.next };
      },
    }));
    const results = await paginateStreams(ctx, server, streams);
    return new Map(
      queries.map((q) => {
        const r = results.get(q.id)!;
        const f = flags.get(q.id)!;
        return [q.id, { items: r.items, pages: r.pages, complete: r.complete && !f.stuck && !f.uncounted, error: r.error, notes: finishNotes(f.stuck, f.uncounted) }];
      }),
    );
  };
  return {
    async identify() {
      // Both reads in one Claude Code session.
      const plan = [
        { id: "me", tool: "atlassianUserInfo", args: {} },
        { id: "sites", tool: "getAccessibleAtlassianResources", args: {} },
      ];
      const outcomes = await ctx.claude.run(server, plan, { signal: ctx.signal });
      const read = (i: number) => checked(json(outcomeText(outcomes, plan[i]!, "Atlassian"), `Atlassian ${plan[i]!.tool}`), `Atlassian ${plan[i]!.tool}`);
      return { account: accountOf(read(0)), ...resolveSite(read(1), siteUrl(ctx)) };
    },
    async selfAccountId() {
      const me = await call("atlassianUserInfo", {});
      const accountId = str(pick(me, "account_id")) ?? str(pick(me, "accountId"));
      if (!accountId) throw new RemoteError("Could not identify your Atlassian account to check for an earlier attempt", "error");
      return accountId;
    },
    searchJql: (queries, opts = {}) => {
      const size = opts.pageSize ?? PAGE_SIZE;
      return search(queries, "searchJiraIssuesUsingJql", (q, cursor) => ({ cloudId: id(), jql: q.query, maxResults: size, fields: FIELDS, ...(cursor ? { nextPageToken: cursor } : {}) }), jiraPage, opts.maxPages ?? DEFAULT_PAGES);
    },
    searchCql: (queries, opts = {}) => {
      const size = opts.pageSize ?? PAGE_SIZE;
      return search(queries, "searchConfluenceUsingCql", (q, cursor) => ({ cloudId: id(), cql: q.query, limit: size, ...(cursor ? { cursor } : {}) }), (res) => confluencePage(res, size), opts.maxPages ?? DEFAULT_PAGES);
    },
    addJiraComment: async (key, markdown) => (await call("addCommentToJiraIssue", { cloudId: id(), issueIdOrKey: key, commentBody: markdown, contentFormat: "markdown" }, { write: true })) as Record<string, unknown>,
    async listJiraComments(key) {
      const res = await call("getJiraIssue", { cloudId: id(), issueIdOrKey: key, fields: ["comment"] });
      const node = (pick(res, "issues", "nodes") as unknown[] | undefined)?.[0] ?? res;
      const comment = pick(node, "fields", "comment");
      const { items, total } = commentsOf(comment);
      return { items, complete: total === null || items.length >= total };
    },
    addConfluenceComment: async (pageId, text) => (await call("createConfluenceFooterComment", { cloudId: id(), pageId, body: text, contentFormat: "markdown" }, { write: true })) as Record<string, unknown>,
    async listConfluenceComments(pageId) {
      const items: Array<Record<string, unknown>> = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const res = await call("getConfluencePageFooterComments", { cloudId: id(), pageId, limit: 100, sort: "-created-date", contentFormat: "markdown", ...(cursor ? { cursor } : {}) });
        items.push(...commentsOf(res).items);
        cursor = linkCursor(res);
        if (!cursor) return { items, complete: true };
      }
      return { items, complete: false };
    },
  };
}
