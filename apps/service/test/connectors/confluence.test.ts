import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { confluenceAdapter, normalizeHit, toStorage } from "../../src/connectors/confluence.ts";
import { confluencePage } from "../../src/connectors/atlassian-backend.ts";
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
const TOKEN = "ATATT3xFfGF0confluencetokentest";

const hit = (id: string, title = `Page ${id}`, version = 1) => ({
  content: { id, type: "page", title, version: { number: version, by: { displayName: "Mia" } }, space: { key: "ENG", name: "Engineering" }, _links: { webui: `/spaces/ENG/pages/${id}` } },
  excerpt: `${title} excerpt`,
  lastModified: "2026-09-29T10:00:00.000Z",
});

beforeEach(() => {
  fx.reset();
  atl = mountAtlassianMcp(fx);
  atl.apiTokens.add(`alex@acme.com:${TOKEN}`);
  atl.tools.set("atlassianUserInfo", () => ({ account_id: "acc-alex", email: "alex@acme.com" }));
  atl.tools.set("getAccessibleAtlassianResources", () => [{ id: "cloud-1", url: SITE, name: "Acme" }]);
});

const ctx = (scopes = ["mentions"], settings: Record<string, unknown> = {}) => {
  const c = fixtureContext({ kind: "confluence", baseUrl: fx.url, secrets: { apiToken: TOKEN }, settings: { siteUrl: SITE, email: "alex@acme.com", authMethod: "api-token", cloudId: "cloud-1", ...settings }, readScopes: scopes });
  c.endpoint = (d) => (d === ATLASSIAN_MCP_BASE ? `${fx.url}${MCP_PREFIX}` : d);
  return c;
};

const searches = () => atl.calls.filter((c) => c.name === "searchConfluence");

describe("Confluence adapter contract (Atlassian Rovo MCP server)", () => {
  it("authorization: API token test identifies the account and the site", async () => {
    atl.tools.set("searchConfluence", () => ({ results: [] }));
    expect(await confluenceAdapter.test(ctx())).toMatchObject({ ok: true, account: "alex@acme.com", settings: { cloudId: "cloud-1" } });
    const bad = ctx();
    bad.secrets.set("apiToken", "nope");
    expect(await confluenceAdapter.test(bad)).toMatchObject({ ok: false, state: "unauthorized" });
  });

  it("scope: mentions produce attention; space updates need configured spaces and quote them in CQL", async () => {
    atl.tools.set("searchConfluence", (args) => ({ results: String(args.cql).startsWith("mention") ? [hit("1001", "Q4 planning")] : [hit("2002")] }));
    const r = await confluenceAdapter.refresh!(ctx(["mentions", "space_updates"]));
    expect(r.observations.filter((o) => o.attention).map((o) => o.attention!.key)).toEqual(["confluence:mention:1001"]);
    expect(r.coverage.scopes.find((s) => s.scope.startsWith("Updates"))).toMatchObject({ state: "not_configured" });
    expect(searches()).toHaveLength(1);
    atl.calls.length = 0;
    await confluenceAdapter.refresh!(ctx(["space_updates"], { spaces: "ENG,OPS" }));
    expect(searches()[0]!.args.cql).toContain('space in ("ENG","OPS")');
    expect(searches()[0]!.args.cloudId).toBe("cloud-1");
  });

  it("pagination: follows the cursor (explicit or inside _links.next); a cap is partial", async () => {
    atl.tools.set("searchConfluence", (args) => {
      if (!args.cursor) return { results: [hit("1")], nextCursor: "c2" };
      if (args.cursor === "c2") return { results: [hit("2")], _links: { next: "/rest/api/search?cql=x&cursor=c3" } };
      return { results: [hit("3")] };
    });
    const r = await confluenceAdapter.refresh!(ctx(["my_recent"]));
    expect(r.observations.map((o) => o.externalId)).toEqual(["1", "2", "3"]);
    expect(r.coverage.state).toBe("complete");
    atl.tools.set("searchConfluence", (args) => ({ results: [hit(String(Number(args.cursor ?? 0) + 1))], nextCursor: String(Number(args.cursor ?? 0) + 1) }));
    expect((await confluenceAdapter.refresh!(ctx(["my_recent"]))).coverage.state).toBe("partial");
  });

  it("pagination: a next link without a cursor is partial, never the last page", async () => {
    atl.tools.set("searchConfluence", () => ({ results: [hit("1")], _links: { next: "/rest/api/search?start=50" } }));
    const r = await confluenceAdapter.refresh!(ctx(["my_recent"]));
    expect(r.coverage.state).toBe("partial");
    expect(r.observations).toHaveLength(1);
  });

  it("retry, empty and partial: 5xx retried, zero is empty, bad shape errors, unreadable hits are partial", async () => {
    atl.tools.set("searchConfluence", () => ({ results: [] }));
    atl.failNext = [502];
    expect((await confluenceAdapter.refresh!(ctx())).coverage.state).toBe("empty");
    atl.tools.set("searchConfluence", () => "not json at all");
    expect((await confluenceAdapter.refresh!(ctx())).coverage.state).toBe("error");
    atl.tools.set("searchConfluence", () => ({ results: [hit("1"), { content: { title: "no id" } }] }));
    expect((await confluenceAdapter.refresh!(ctx())).coverage.state).toBe("partial");
    atl.tools.set("searchConfluence", () => {
      throw new ToolError("Forbidden", 403);
    });
    expect((await confluenceAdapter.refresh!(ctx())).coverage.state).toBe("denied");
  });

  it("execute: creates a storage-format footer comment carrying the effect marker, verified by reading it back", async () => {
    const comments: Array<Record<string, unknown>> = [];
    executeOps(atl, {
      createConfluenceComment: (inputs) => {
        const c = { id: String(500 + comments.length), pageId: inputs.pageId, body: { storage: { value: (inputs.body as { value: string }).value } }, version: { authorId: "acc-alex" }, _links: { webui: `/spaces/ENG/pages/${String(inputs.pageId)}?focusedCommentId=${500 + comments.length}` } };
        comments.push(c);
        return c;
      },
      listConfluenceComments: (inputs) => ({ results: comments.filter((c) => c.pageId === inputs.pageId) }),
    });
    const action = { kind: "confluence.comment", target: { pageId: "1001" }, payload: { body: "Agreed <with> caveats" }, effectKey: "eff-9" };
    expect(await confluenceAdapter.findEffect!(ctx(), action)).toBeNull();
    const r = await confluenceAdapter.execute!(ctx(), action);
    expect(r).toMatchObject({ verified: true, remoteId: "500" });
    expect(r.url).toBe(`${SITE}/wiki/spaces/ENG/pages/1001?focusedCommentId=500`);
    const sent = atl.calls.find((c) => c.name === "executeWrite")!.args;
    expect(sent).toMatchObject({ name: "createConfluenceComment", cloudId: "cloud-1" });
    expect(JSON.stringify(sent)).toContain("&lt;with&gt;");
    expect(await confluenceAdapter.findEffect!(ctx(), action)).toMatchObject({ verified: true, remoteId: "500" });
    // Marker stripped by the server: recovery still matches author and text.
    comments[0]!.body = { storage: { value: "<p>Agreed &lt;with&gt; caveats</p>" } };
    expect(await confluenceAdapter.findEffect!(ctx(), action)).toMatchObject({ verified: true });
  });

  it("helpers: storage escaping and marker, flattened hits, cursor extraction", () => {
    expect(toStorage("a <b>\nc\n\nd", "k")).toBe("<p>a &lt;b&gt;<br/>c</p><p>d</p><!-- jarvis:effect=k -->");
    expect(normalizeHit({ id: "12", title: "Flat", type: "page", spaceKey: "OPS" })).toMatchObject({ id: "12", title: "Flat", space: "OPS" });
    expect(normalizeHit({ content: { id: "abc" } })).toBeNull();
    expect(confluencePage({ results: [], _links: { next: "/wiki/rest/api/search?cursor=zz%3D&limit=50" } }, 50).next).toBe("zz=");
    expect(confluencePage({ results: [] }, 50).next).toBeNull();
    // The claude.ai (v1) view: no total and no next page, so a full page may hide more.
    expect(confluencePage({ content: { totalCount: 2, nodes: [{}, {}] } }, 2)).toMatchObject({ next: null, uncounted: true });
    expect(confluencePage({ content: { totalCount: 1, nodes: [{}] } }, 2)).toMatchObject({ uncounted: false });
  });
});
