import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { confluenceAdapter, resolveNext } from "../../src/connectors/confluence.ts";
import { startFixtureServer, type FixtureServer, type FixtureRequest } from "../fixtures/fixture-server.ts";
import { fixtureContext } from "../fixtures/adapter-harness.ts";

let fx: FixtureServer;
beforeAll(async () => {
  fx = await startFixtureServer();
});
afterAll(() => fx.close());
beforeEach(() => fx.reset());

const TOKEN = "ATATT3xFfGF0confluencetesttoken";
const EXPECTED_AUTH = `Basic ${Buffer.from(`alex@acme.com:${TOKEN}`).toString("base64")}`;
const SEARCH = "/wiki/rest/api/search";

const page = (id: string, version = 1, title = `Page ${id}`) => ({
  content: { id, type: "page", title, version: { number: version, by: { displayName: "Mia" } }, space: { key: "ENG", name: "Engineering" }, _links: { webui: `/spaces/ENG/pages/${id}` } },
  title,
  excerpt: "hello @Alex",
  lastModified: "2026-09-29T10:00:00.000Z",
});

const ok = (results: unknown[], next?: string) => ({ json: { results, _links: { base: "https://acme.atlassian.net/wiki", context: "/wiki", ...(next ? { next } : {}) } } });

const ctx = (scopes = ["mentions"], opts: { secrets?: Record<string, string>; spaces?: string } = {}) =>
  fixtureContext({ kind: "confluence", baseUrl: fx.url, secrets: opts.secrets ?? { apiToken: TOKEN }, settings: { siteUrl: "https://acme.atlassian.net", email: "alex@acme.com", spaces: opts.spaces ?? "" }, readScopes: scopes });

const cqlOf = (r: FixtureRequest) => r.query.get("cql") ?? "";
const searches = () => fx.requests.filter((r) => r.path === SEARCH);

describe("Confluence adapter contract", () => {
  it("authorization: sends Basic email:token and reports the account; anonymous is unauthorized", async () => {
    fx.route("GET", "/wiki/rest/api/user/current", (req) => (req.headers.authorization === EXPECTED_AUTH ? { json: { type: "known", displayName: "Alex", email: "alex@acme.com" } } : { status: 401, json: {} }));
    expect(await confluenceAdapter.test(ctx())).toMatchObject({ ok: true, account: "alex@acme.com" });
    fx.route("GET", "/wiki/rest/api/user/current", () => ({ json: { type: "anonymous" } }));
    expect(await confluenceAdapter.test(ctx())).toMatchObject({ ok: false, state: "unauthorized" });
  });

  it("authorization failure is 'unauthorized', not empty", async () => {
    fx.route("GET", SEARCH, () => ({ status: 401, json: {} }));
    const s = await confluenceAdapter.sync!(ctx(["mentions", "my_recent"]));
    expect(s.coverage.state).toBe("unauthorized");
  });

  it("configure strips a /wiki suffix and validates space keys", async () => {
    const c = ctx([], { secrets: {} });
    const settings = await confluenceAdapter.configure(c, { siteUrl: "https://acme.atlassian.net/wiki/", email: "alex@acme.com", apiToken: TOKEN, spaces: "ENG, OPS" });
    expect(settings).toMatchObject({ siteUrl: "https://acme.atlassian.net", spaces: "ENG,OPS" });
    expect(c.secrets.get("apiToken")).toBe(TOKEN);
    await expect(confluenceAdapter.configure(c, { siteUrl: "https://acme.atlassian.net", email: "alex@acme.com", apiToken: TOKEN, spaces: 'ENG") OR (1=1' })).rejects.toThrow(/space key/);
  });

  it("scope: only selected scopes are queried; space_updates uses the configured spaces; 403 is denied", async () => {
    fx.route("GET", SEARCH, (req) => (cqlOf(req).startsWith("contributor") ? { status: 403, json: {} } : ok([])));
    const s = await confluenceAdapter.sync!(ctx(["my_recent", "space_updates"], { spaces: "ENG,OPS" }));
    const cqls = searches().map(cqlOf);
    expect(cqls.some((q) => q.startsWith("mention"))).toBe(false);
    expect(cqls).toContain('space in ("ENG","OPS") AND lastmodified >= now("-7d") ORDER BY lastmodified DESC');
    expect(s.coverage.scopes.find((c) => c.scope.includes("contributed"))!.state).toBe("denied");
    expect(s.coverage.state).toBe("partial");
  });

  it("space_updates without spaces is not queried and says so", async () => {
    fx.route("GET", SEARCH, () => ok([]));
    const s = await confluenceAdapter.sync!(ctx(["space_updates"]));
    expect(searches()).toHaveLength(0);
    expect(s.coverage.scopes[0]).toMatchObject({ state: "not_configured" });
  });

  it("pagination: follows a relative _links.next under the /wiki context (the 404 trap)", async () => {
    fx.route("GET", SEARCH, (req) => (req.query.get("cursor") === "c2" ? ok([page("3")]) : ok([page("1"), page("2")], "/rest/api/search?cql=x&cursor=c2")));
    const s = await confluenceAdapter.sync!(ctx());
    expect(s.observations.map((o) => o.externalId)).toEqual(["1", "2", "3"]);
    expect(s.coverage.scopes[0]).toMatchObject({ state: "complete", pages: 2, items: 3 });
    expect(fx.requests.every((r) => r.path === SEARCH)).toBe(true);
  });

  it("resolveNext joins relative, /wiki-prefixed and absolute next links correctly", () => {
    const site = "https://acme.atlassian.net";
    expect(resolveNext(site, { next: "/rest/api/search?cursor=a", context: "/wiki" })).toBe("https://acme.atlassian.net/wiki/rest/api/search?cursor=a");
    expect(resolveNext(site, { next: "/wiki/api/v2/pages/1/footer-comments?cursor=b" })).toBe("https://acme.atlassian.net/wiki/api/v2/pages/1/footer-comments?cursor=b");
    expect(resolveNext("http://127.0.0.1:1/confluence", { next: "https://acme.atlassian.net/wiki/rest/api/search?cursor=c" })).toBe("http://127.0.0.1:1/confluence/wiki/rest/api/search?cursor=c");
    expect(resolveNext(site, {})).toBeNull();
  });

  it("retry: retries 429 honouring Retry-After, then succeeds", async () => {
    let calls = 0;
    fx.route("GET", SEARCH, () => (++calls < 3 ? { status: 429, headers: { "retry-after": "0" }, json: {} } : ok([])));
    const s = await confluenceAdapter.sync!(ctx());
    expect(calls).toBe(3);
    expect(s.coverage.state).toBe("empty");
  });

  it("empty result is 'empty'; partial on mid-pagination failure and page cap", async () => {
    fx.route("GET", SEARCH, () => ok([]));
    expect((await confluenceAdapter.sync!(ctx())).coverage.scopes[0]).toMatchObject({ state: "empty", pages: 1 });
    fx.reset();
    fx.route("GET", SEARCH, (req) => (req.query.get("cursor") ? { status: 500, json: {} } : ok([page("1")], "/rest/api/search?cursor=c2")));
    const p = await confluenceAdapter.sync!(ctx());
    expect(p.coverage.state).toBe("partial");
    expect(p.observations).toHaveLength(1);
    fx.reset();
    let n = 0;
    fx.route("GET", SEARCH, () => ok([page(String(++n))], `/rest/api/search?cursor=c${n + 1}`));
    expect((await confluenceAdapter.sync!(ctx())).coverage.scopes[0]).toMatchObject({ state: "partial", pages: 4 });
  });

  it("disconnect: without a stored token no request is made", async () => {
    const s = await confluenceAdapter.sync!(ctx(["mentions"], { secrets: {} }));
    expect(s.coverage.state).toBe("unauthorized");
    expect(fx.requests).toHaveLength(0);
  });

  it("attention only for mentions; pages dedupe with the mention winning; fingerprint is title + version", async () => {
    let version = 1;
    fx.route("GET", SEARCH, (req) => (cqlOf(req).startsWith("mention") ? ok([page("1", version)]) : ok([page("1", version), page("2")])));
    const a = await confluenceAdapter.sync!(ctx(["mentions", "my_recent"]));
    expect(a.observations.map((o) => [o.externalId, o.kind])).toEqual([["1", "confluence_mention"], ["2", "confluence_page"]]);
    expect(a.observations[0]!.attention).toMatchObject({ key: "confluence:mention:1", kind: "mention", url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/1" });
    expect(a.observations[1]!.attention).toBeUndefined();
    expect(a.observations[0]!.fingerprintParts).toEqual(["Page 1", 1]);
    version = 2;
    const b = await confluenceAdapter.sync!(ctx(["mentions"]));
    expect(b.observations[0]!.fingerprintParts).toEqual(["Page 1", 2]);
  });

  it("write: posts once, tags a property, verifies by read-back; recovery finds it by property", async () => {
    const comments: Array<{ id: string; pageId: string; body: { storage: { value: string } } }> = [{ id: "50", pageId: "1", body: { storage: { value: "<p>older</p>" } } }];
    const props = new Map<string, Array<{ key: string; value: unknown }>>();
    fx.route("POST", "/wiki/api/v2/footer-comments", (req) => {
      const b = req.body as { pageId: string; body: { value: string } };
      // Emulate storage-format sanitising stripping HTML comments, so only the property can prove the effect.
      const c = { id: String(100 + comments.length), pageId: b.pageId, body: { storage: { value: b.body.value.replace(/<!--.*?-->/g, "") } }, _links: { webui: `/spaces/ENG/pages/1?focusedCommentId=${100 + comments.length}` } };
      comments.push(c);
      return { status: 201, json: c };
    });
    fx.route("POST", /^\/wiki\/api\/v2\/footer-comments\/\d+\/properties$/, (req) => {
      const id = req.path.split("/")[5]!;
      props.set(id, [...(props.get(id) ?? []), req.body as { key: string; value: unknown }]);
      return { json: req.body };
    });
    fx.route("GET", /^\/wiki\/api\/v2\/footer-comments\/\d+\/properties$/, (req) => ({ json: { results: props.get(req.path.split("/")[5]!) ?? [], _links: {} } }));
    fx.route("GET", /^\/wiki\/api\/v2\/footer-comments\/\d+$/, (req) => ({ json: comments.find((c) => c.id === req.path.split("/").pop()) }));
    fx.route("GET", "/wiki/api/v2/pages/1/footer-comments", (req) =>
      req.query.get("cursor") ? { json: { results: comments.slice(1), _links: {} } } : { json: { results: comments.slice(0, 1), _links: { next: "/wiki/api/v2/pages/1/footer-comments?cursor=n2" } } },
    );
    const action = { kind: "confluence.comment", target: { pageId: "1" }, payload: { body: "Looks <good> & done" }, effectKey: "eff-c" };
    const r = await confluenceAdapter.execute!(ctx(), action);
    expect(r).toMatchObject({ verified: true, remoteId: "101" });
    const posted = fx.requests.find((q) => q.method === "POST" && q.path === "/wiki/api/v2/footer-comments")!.body as { body: { representation: string; value: string } };
    expect(posted.body).toEqual({ representation: "storage", value: "<p>Looks &lt;good&gt; &amp; done</p><!-- jarvis:effect=eff-c -->" });
    expect(await confluenceAdapter.findEffect!(ctx(), action)).toMatchObject({ verified: true, remoteId: "101" });
    expect(await confluenceAdapter.findEffect!(ctx(), { ...action, effectKey: "other" })).toBeNull();
    expect(fx.requests.filter((q) => q.method === "POST" && q.path === "/wiki/api/v2/footer-comments")).toHaveLength(1);
  });

  it("recovery throws partial when comments cannot all be read", async () => {
    fx.route("GET", "/wiki/api/v2/pages/1/footer-comments", (req) => (req.query.get("cursor") ? { status: 502, json: {} } : { json: { results: [], _links: { next: "/wiki/api/v2/pages/1/footer-comments?cursor=n2" } } }));
    await expect(confluenceAdapter.findEffect!(ctx(), { kind: "confluence.comment", target: { pageId: "1" }, payload: {}, effectKey: "k" })).rejects.toMatchObject({ state: "partial" });
  });
});
