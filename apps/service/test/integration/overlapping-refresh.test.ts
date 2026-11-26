/**
 * Two Source refreshes of one Connection that overlap, as the first refresh after Setup and a refresh by hand do on
 * a busy computer: the Inbox shows what the later read found, even when the earlier refresh finishes last.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";

const TOKEN = "ghp_OverlappingRefresh0123456789abcdefXYZ";
const TEN_DAYS_AGO = () => new Date(Date.now() - 10.5 * 86_400_000).toISOString();

let svc: TestService;
let fx: FixtureServer;
/** The pull requests GitHub asks the owner to review, read when a request arrives. */
let prs: number[] = [];
/** While set, GitHub reads the review requests when asked but answers only when the hold is released. */
let hold: { arrived: () => void; release: Promise<void> } | null = null;

beforeAll(async () => {
  fx = await startFixtureServer();
  fx.route("GET", "/user", () => ({ json: { login: "owner" }, headers: { "x-oauth-scopes": "repo" } }));
  fx.route("GET", "/search/issues", async (req) => {
    const asked = req.query.get("q")!.includes("review-requested:@me");
    const items = asked ? prs.map((n) => ({ number: n, title: `Change ${n}`, html_url: `https://github.com/a/b/pull/${n}`, state: "open", draft: false, user: { login: "ada" }, repository_url: "https://api.github.com/repos/a/b", created_at: TEN_DAYS_AGO(), updated_at: new Date().toISOString() })) : [];
    const held = asked ? hold : null;
    if (held) {
      hold = null;
      held.arrived();
      await held.release;
    }
    return { json: { incomplete_results: false, items } };
  });
  fx.route("GET", /\/pulls\/\d+$/, () => ({ json: { head: { sha: "abc" } } }));
  svc = await startTestService();
  await svc.post("/connections/github/configure", { method: "token", fields: { token: TOKEN, apiBaseUrl: fx.url } });
});
afterAll(async () => {
  await svc.stop();
  await fx.close();
});

const refresh = async () => (await svc.post("/connections/github/refresh")).job.id as string;
const openReviews = async () => ((await svc.get("/attention?state=open")).items as Array<{ title: string }>).map((i) => i.title).filter((t) => t.startsWith("Review a/b#")).sort();

describe("overlapping Source refreshes of one Connection", () => {
  it("keep the later read when the earlier refresh finishes last", async () => {
    prs = [7];
    await svc.waitJob(await refresh());
    expect(await openReviews()).toEqual(["Review a/b#7: Change 7"]);

    // The earlier refresh reads GitHub while #7 still asks for a review, and is slow to finish.
    let release!: () => void;
    const arrived = new Promise<void>((arrive) => (hold = { arrived: arrive, release: new Promise((r) => (release = r)) }));
    const earlier = await refresh();
    await arrived;

    // Meanwhile #7 is reviewed and #8 asks for one; a later refresh reads that and finishes first.
    prs = [8];
    await svc.waitJob(await refresh());
    expect(await openReviews()).toEqual(["Review a/b#8: Change 8"]);

    release();
    expect((await svc.waitJob(earlier)).job.status).toBe("succeeded");
    expect(await openReviews()).toEqual(["Review a/b#8: Change 8"]);
  });
});
