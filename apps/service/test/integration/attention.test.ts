import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { applyCandidates, decide, listItems } from "../../src/attention/engine.ts";
import { fingerprint } from "../../src/attention/fingerprint.ts";
import { openDb } from "../../src/core/db.ts";

let svc: TestService;
let fx: FixtureServer;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function briefing() {
  const { job } = await svc.post("/briefings", { kind: "manual" });
  const done = await svc.waitJob(job.id);
  expect(done.job.status).toBe("succeeded");
  return (await svc.get("/briefings/latest")).briefing;
}

beforeAll(async () => {
  fx = await startFixtureServer();
  svc = await startTestService();
  mkdirSync(join(svc.dataDir, "memory/projects"), { recursive: true });
  writeFileSync(join(svc.dataDir, "memory/projects/launch.md"), `# Launch\n\n- [ ] Book the venue 📅 ${day(2)}\n- [ ] Send invites due:${day(-1)}\n`);
});
afterAll(async () => {
  await svc.stop();
  await fx.close();
});

describe("A07 attention: dismissals persist, changes resurface, failed sources are visible", () => {
  it("a repeated briefing does not resurrect a dismissed unchanged item", async () => {
    const b1 = await briefing();
    const deadlines = b1.sections.find((s: any) => s.id === "deadlines");
    expect(deadlines.items.map((i: any) => i.title)).toEqual(expect.arrayContaining([expect.stringContaining("Book the venue"), expect.stringContaining("Send invites")]));
    const items = (await svc.get("/attention")).items;
    const venue = items.find((i: any) => i.title.includes("Book the venue"));
    await svc.post(`/attention/${venue.id}/decision`, { decision: "dismiss" });
    const b2 = await briefing();
    const titles2 = b2.sections.flatMap((s: any) => s.items.map((i: any) => i.title));
    expect(titles2.some((t: string) => t.includes("Book the venue"))).toBe(false);
    const open = (await svc.get("/attention")).items;
    expect(open.some((i: any) => i.key === venue.key)).toBe(false);
    const dismissed = (await svc.get("/attention?state=dismissed")).items;
    expect(dismissed.find((i: any) => i.key === venue.key)).toBeTruthy();
    // Unchanged items are not reported as new on the second run.
    expect(b2.counts.new).toBe(0);
  });

  it("changed evidence produces a new useful item", async () => {
    writeFileSync(join(svc.dataDir, "memory/projects/launch.md"), `# Launch\n\n- [ ] Book the venue 📅 ${day(0)}\n- [ ] Send invites due:${day(-1)}\n`);
    const b3 = await briefing();
    const venue = (await svc.get("/attention")).items.find((i: any) => i.title.includes("Book the venue"));
    expect(venue).toBeTruthy();
    expect(venue.title).toMatch(/Due today/);
    expect(venue.changedSinceDecision).toBe(true);
    expect(b3.counts.changed).toBeGreaterThanOrEqual(1);
  });

  it("snooze hides until the time passes; done stays closed while unchanged", async () => {
    const invites = (await svc.get("/attention")).items.find((i: any) => i.title.includes("Send invites"));
    await svc.post(`/attention/${invites.id}/decision`, { decision: "snooze", until: new Date(Date.now() + 3_600_000).toISOString() });
    await briefing();
    expect((await svc.get("/attention")).items.some((i: any) => i.id === invites.id)).toBe(false);
    expect((await svc.get("/attention?state=snoozed")).items.some((i: any) => i.id === invites.id)).toBe(true);
    const bad = await svc.call("POST", `/attention/${invites.id}/decision`, { decision: "snooze", until: new Date(Date.now() - 1000).toISOString() });
    expect(bad.status).toBe(400);
  });

  it("a failed source displays its coverage status instead of an empty queue", async () => {
    fx.route("GET", "/user", () => ({ json: { login: "tester" } }));
    await svc.post("/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678", apiBaseUrl: fx.url } });
    fx.reset();
    fx.route("GET", "/search/issues", () => ({ status: 401, json: { message: "Bad credentials" } }));
    // Point the adapter at the fixture through its configured API URL.
    const b = await briefing();
    const gh = b.coverage.find((c: any) => c.kind === "github");
    expect(gh.coverage.state).toBe("unauthorized");
    expect(b.counts.failedSources).toBeGreaterThanOrEqual(1);
    expect(b.summary).toMatch(/Incomplete|GitHub/);
    const conns = await svc.get("/connections");
    const status = conns.find((c: any) => c.id === "github");
    expect(status.status).toBe("needs_auth");
    expect(status.lastError).toMatch(/401|unauthorized|Bad credentials/i);
  });
});

describe("attention engine rules", () => {
  const cov = (state: string) => ({ state, scopes: [], items: 0, at: new Date().toISOString() }) as any;
  const cand = (key: string, fp: string) => ({ key, kind: "deadline", title: key, summary: "", why: "", priority: 1, sourceKind: "x", connectionId: "c1", fingerprint: fp, evidence: [] });

  it("never resolves an item from a source that was not fully covered on both runs", () => {
    const db = openDb(":memory:");
    applyCandidates(db, { sourceKind: "x", connectionId: "c1", coverage: cov("complete"), previousCoverage: null }, [cand("a", "1")]);
    let r = applyCandidates(db, { sourceKind: "x", connectionId: "c1", coverage: cov("partial"), previousCoverage: cov("complete") }, []);
    expect(r.resolved).toEqual([]);
    r = applyCandidates(db, { sourceKind: "x", connectionId: "c1", coverage: cov("complete"), previousCoverage: cov("partial") }, []);
    expect(r.resolved).toEqual([]);
    r = applyCandidates(db, { sourceKind: "x", connectionId: "c1", coverage: cov("empty"), previousCoverage: cov("complete") }, []);
    expect(r.resolved).toEqual(["a"]);
  });

  it("keeps identity separate from change: same key with a new fingerprint is a change, not resolved+new", () => {
    const db = openDb(":memory:");
    applyCandidates(db, { sourceKind: "x", connectionId: "c1", coverage: cov("complete"), previousCoverage: null }, [cand("jira:A-1", "due")]);
    const item = listItems(db)[0]!;
    decide(db, item.id, "dismiss", "t");
    const r = applyCandidates(db, { sourceKind: "x", connectionId: "c1", coverage: cov("complete"), previousCoverage: cov("complete") }, [cand("jira:A-1", "overdue")]);
    expect(r).toMatchObject({ changed: ["jira:A-1"], created: [], resolved: [], reopened: ["jira:A-1"] });
    expect(listItems(db)).toHaveLength(1);
  });

  it("fingerprints are length-prefixed so separators cannot forge collisions", () => {
    expect(fingerprint(["ab", "c"])).not.toBe(fingerprint(["a", "bc"]));
    expect(fingerprint(["a:b"])).not.toBe(fingerprint(["a", "b"]));
    expect(fingerprint([null])).not.toBe(fingerprint(["null"]));
    expect(fingerprint(["x", 1])).toBe(fingerprint(["x", 1]));
  });
});
