import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { githubAdapter } from "../../src/connectors/github.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { fixtureContext } from "../fixtures/adapter-harness.ts";

let fx: FixtureServer;
beforeAll(async () => {
  fx = await startFixtureServer();
});
afterAll(() => fx.close());
beforeEach(() => fx.reset());

const pr = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `Change ${n}`,
  html_url: `https://github.com/acme/web/pull/${n}`,
  state: "open",
  draft: false,
  user: { login: "mia" },
  repository_url: "https://api.github.com/repos/acme/web",
  created_at: "2026-09-28T10:00:00Z",
  updated_at: "2026-09-29T10:00:00Z",
  body: "Please review",
  pull_request: {},
  ...extra,
});

const ctx = (scopes = ["review_requests"]) => fixtureContext({ kind: "github", baseUrl: fx.url, secrets: { token: "ghp_testtokentesttokentesttoken123456" }, readScopes: scopes });

describe("GitHub adapter contract", () => {
  it("authorization: sends the bearer token and reports the signed-in account", async () => {
    fx.route("GET", "/user", (req) => (req.headers.authorization === "Bearer ghp_testtokentesttokentesttoken123456" ? { json: { login: "alex" }, headers: { "x-oauth-scopes": "repo, read:org" } } : { status: 401, json: { message: "Bad credentials" } }));
    const r = await githubAdapter.test(ctx());
    expect(r).toMatchObject({ ok: true, account: "alex", grantedScopes: ["repo", "read:org"] });
  });

  it("authorization failure is 'unauthorized', not empty", async () => {
    fx.route("GET", "/user", () => ({ status: 401, json: { message: "Bad credentials" } }));
    fx.route("GET", "/search/issues", () => ({ status: 401, json: { message: "Bad credentials" } }));
    expect((await githubAdapter.test(ctx())).state).toBe("unauthorized");
    const s = await githubAdapter.refresh!(ctx());
    expect(s.coverage.state).toBe("unauthorized");
    expect(s.observations).toHaveLength(0);
  });

  it("scope: only queries the selected scopes, and a 403 scope is 'denied'", async () => {
    fx.route("GET", "/search/issues", (req) => (req.query.get("q")!.includes("assignee") ? { status: 403, json: { message: "Resource not accessible by integration" } } : { json: { items: [], incomplete_results: false } }));
    const s = await githubAdapter.refresh!(ctx(["review_requests", "assigned_issues"]));
    const qs = fx.requests.filter((r) => r.path === "/search/issues").map((r) => r.query.get("q"));
    expect(qs.some((q) => q!.includes("author:@me"))).toBe(false);
    expect(s.coverage.scopes.find((c) => c.scope.includes("assigned"))!.state).toBe("denied");
    expect(s.coverage.state).toBe("partial");
  });

  it("pagination: follows Link rel=next across pages", async () => {
    fx.route("GET", "/search/issues", (req) =>
      req.query.get("page") === "2"
        ? { json: { items: [pr(3)], incomplete_results: false } }
        : { json: { items: [pr(1), pr(2)], incomplete_results: false }, headers: { link: `<${fx.url}/search/issues?q=x&page=2>; rel="next"` } },
    );
    fx.route("GET", /^\/repos\/acme\/web\/pulls\/\d+$/, (req) => ({ json: { head: { sha: `sha-${req.path.split("/").pop()}` } } }));
    const s = await githubAdapter.refresh!(ctx());
    expect(s.observations.map((o) => o.externalId)).toEqual(["acme/web#1", "acme/web#2", "acme/web#3"]);
    expect(s.coverage.state).toBe("complete");
    expect(s.coverage.scopes[0]).toMatchObject({ pages: 2, items: 3 });
    expect(s.observations[0]!.attention?.key).toBe("github:pr:acme/web#1");
  });

  it("partial coverage: a failure after page one and incomplete_results are reported as partial", async () => {
    fx.route("GET", "/search/issues", (req) =>
      req.query.get("page") === "2" ? { status: 502, json: { message: "bad gateway" } } : { json: { items: [pr(1)], incomplete_results: false }, headers: { link: `<${fx.url}/search/issues?q=x&page=2>; rel="next"` } },
    );
    fx.route("GET", /pulls/, () => ({ json: { head: { sha: "a" } } }));
    const s = await githubAdapter.refresh!(ctx());
    expect(s.coverage.state).toBe("partial");
    expect(s.observations).toHaveLength(1);
    fx.reset();
    fx.route("GET", "/search/issues", () => ({ json: { items: [], incomplete_results: true } }));
    expect((await githubAdapter.refresh!(ctx())).coverage.state).toBe("partial");
  });

  it("retry: retries 429 honouring Retry-After, then succeeds", async () => {
    let calls = 0;
    fx.route("GET", "/search/issues", () => (++calls < 3 ? { status: 429, headers: { "retry-after": "0" }, json: { message: "slow down" } } : { json: { items: [], incomplete_results: false } }));
    const s = await githubAdapter.refresh!(ctx());
    expect(calls).toBe(3);
    expect(s.coverage.state).toBe("empty");
  });

  it("empty result: a successful zero is 'empty', distinct from failure", async () => {
    fx.route("GET", "/search/issues", () => ({ json: { items: [], incomplete_results: false } }));
    const s = await githubAdapter.refresh!(ctx());
    expect(s.coverage.state).toBe("empty");
    expect(s.coverage.scopes[0]).toMatchObject({ state: "empty", pages: 1, items: 0 });
  });

  it("offline: network failure is 'offline'", async () => {
    const c = fixtureContext({ kind: "github", baseUrl: "http://127.0.0.1:9", secrets: { token: "t" }, readScopes: ["review_requests"] });
    const s = await githubAdapter.refresh!(c);
    expect(s.coverage.state).toBe("offline");
  });

  it("disconnect: without a stored token no request is made", async () => {
    const c = fixtureContext({ kind: "github", baseUrl: fx.url, secrets: {}, readScopes: ["review_requests"] });
    const s = await githubAdapter.refresh!(c);
    expect(s.coverage.state).toBe("unauthorized");
    expect(fx.requests).toHaveLength(0);
  });

  it("fingerprint changes when new commits land, not when only updated_at moves", async () => {
    let sha = "a1";
    let updated = "2026-09-29T10:00:00Z";
    fx.route("GET", "/search/issues", () => ({ json: { items: [pr(7, { updated_at: updated })], incomplete_results: false } }));
    fx.route("GET", /pulls\/7$/, () => ({ json: { head: { sha } } }));
    const a = (await githubAdapter.refresh!(ctx())).observations[0]!.fingerprintParts;
    updated = "2026-09-30T09:00:00Z";
    const b = (await githubAdapter.refresh!(ctx())).observations[0]!.fingerprintParts;
    sha = "b2";
    const c = (await githubAdapter.refresh!(ctx())).observations[0]!.fingerprintParts;
    expect(a).toEqual(b);
    expect(c).not.toEqual(b);
  });

  it("write: posts once with an idempotency marker, verifies by read-back, and recovery finds the earlier effect", async () => {
    const posted: Array<{ id: number; body: string; html_url: string }> = [];
    fx.route("POST", "/repos/acme/web/issues/7/comments", (req) => {
      const c = { id: 100 + posted.length, body: (req.body as { body: string }).body, html_url: "https://github.com/acme/web/pull/7#c" };
      posted.push(c);
      return { status: 201, json: c };
    });
    fx.route("GET", /^\/repos\/acme\/web\/issues\/comments\/\d+$/, (req) => ({ json: posted.find((p) => String(p.id) === req.path.split("/").pop()) }));
    fx.route("GET", "/repos/acme/web/issues/7/comments", () => ({ json: posted }));
    const action = { kind: "github.comment", target: { repo: "acme/web", number: 7 }, payload: { body: "LGTM" }, effectKey: "eff-1" };
    const r = await githubAdapter.execute!(ctx(), action);
    expect(r).toMatchObject({ verified: true, remoteId: "100" });
    expect(posted[0]!.body).toContain("<!-- attache:effect=eff-1 -->");
    const found = await githubAdapter.findEffect!(ctx(), action);
    expect(found?.remoteId).toBe("100");
    expect(await githubAdapter.findEffect!(ctx(), { ...action, effectKey: "other" })).toBeNull();
    expect(fx.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });
});
