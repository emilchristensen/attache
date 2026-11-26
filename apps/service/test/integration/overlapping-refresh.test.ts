/**
 * Two Source refreshes of one Connection that overlap, as the first refresh after Setup and a refresh by hand do on
 * a busy computer: the Inbox shows what the later read found, whichever refresh finishes first.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";

const TOKEN = "ghp_OverlappingRefresh0123456789abcdefXYZ";
const TEN_DAYS_AGO = () => new Date(Date.now() - 10.5 * 86_400_000).toISOString();

interface Hold {
  arrived: () => void;
  release: Promise<void>;
}

let svc: TestService;
let fx: FixtureServer;
/** The pull requests GitHub asks the owner to review, read when a request arrives. */
let prs: number[] = [];
/** Each read of the review requests takes the next hold: it reads them when asked, but answers only when released. */
let holds: Hold[] = [];

beforeAll(async () => {
  fx = await startFixtureServer();
  fx.route("GET", "/user", () => ({ json: { login: "owner" }, headers: { "x-oauth-scopes": "repo" } }));
  fx.route("GET", "/search/issues", async (req) => {
    const asked = req.query.get("q")!.includes("review-requested:@me");
    const items = asked ? prs.map((n) => ({ number: n, title: `Change ${n}`, html_url: `https://github.com/a/b/pull/${n}`, state: "open", draft: false, user: { login: "ada" }, repository_url: "https://api.github.com/repos/a/b", created_at: TEN_DAYS_AGO(), updated_at: new Date().toISOString() })) : [];
    const held = asked ? holds.shift() : undefined;
    if (held) {
      held.arrived();
      await held.release;
    }
    return { json: { incomplete_results: false, items } };
  });
  fx.route("GET", /\/pulls\/\d+$/, () => ({ json: { head: { sha: "abc" } } }));
});
afterAll(async () => {
  await fx.close();
});
// A service of its own for each case, so its first Source refresh is the first this Connection ever ran.
beforeEach(async () => {
  prs = [];
  holds = [];
  svc = await startTestService();
  await svc.post("/connections/github/configure", { method: "token", fields: { token: TOKEN, apiBaseUrl: fx.url } });
});
afterEach(async () => {
  await svc.stop();
});

const refresh = async () => (await svc.post("/connections/github/refresh")).job.id as string;
const openReviews = async () => ((await svc.get("/attention?state=open")).items as Array<{ title: string }>).map((i) => i.title).filter((t) => t.startsWith("Review a/b#")).sort();

/** A refresh whose read of the review requests waits for `release()`; resolves once that read has reached GitHub. */
async function heldRefresh(): Promise<{ id: string; release: () => void }> {
  let release!: () => void;
  const arrived = new Promise<void>((arrive) => holds.push({ arrived: arrive, release: new Promise((r) => (release = r)) }));
  const id = await refresh();
  await arrived;
  return { id, release };
}

describe("overlapping Source refreshes of one Connection", () => {
  it("keep the later read when the earlier refresh finishes last", async () => {
    prs = [7];
    await svc.waitJob(await refresh());
    expect(await openReviews()).toEqual(["Review a/b#7: Change 7"]);

    // The earlier refresh reads GitHub while #7 still asks for a review, and is slow to finish.
    const earlier = await heldRefresh();

    // Meanwhile #7 is reviewed and #8 asks for one; a later refresh reads that and finishes first.
    prs = [8];
    await svc.waitJob(await refresh());
    expect(await openReviews()).toEqual(["Review a/b#8: Change 8"]);

    earlier.release();
    expect((await svc.waitJob(earlier.id)).job.status).toBe("succeeded");
    expect(await openReviews()).toEqual(["Review a/b#8: Change 8"]);
  });

  it("resolve what the earlier read found when the later read, started before it finished, no longer finds it", async () => {
    // The first refresh this Connection runs reads #7 and is slow to finish, as the first refresh after Setup is
    // while Claude Code starts on a busy computer.
    prs = [7];
    const earlier = await heldRefresh();

    // Meanwhile #7 is reviewed and #8 asks for one; a refresh by hand starts and reads that before the first finishes.
    prs = [8];
    const later = await heldRefresh();

    // The first refresh finishes first and stores #7; the later one finishes next with #8 alone, so #7 is resolved.
    earlier.release();
    expect((await svc.waitJob(earlier.id)).job.status).toBe("succeeded");
    expect(await openReviews()).toEqual(["Review a/b#7: Change 7"]);
    later.release();
    expect((await svc.waitJob(later.id)).job.status).toBe("succeeded");
    expect(await openReviews()).toEqual(["Review a/b#8: Change 8"]);
  });
});
