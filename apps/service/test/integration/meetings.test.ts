import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { ATLASSIAN_SITE, installScenarios } from "../fixtures/scenarios.ts";
import { useFakeClaude } from "../fixtures/claude-connectors.ts";

// Each test starts many fake Claude Code processes one after another, which is slow while other suites share the machine.
vi.setConfig({ testTimeout: 120_000 });

let svc: TestService;
let fx: FixtureServer;

async function connectClaude(kind: "gcal" | "gmail") {
  const r = await svc.post(`/connections/${kind}/configure`, { method: "claude-ai", fields: {} });
  expect(r.test).toMatchObject({ ok: true });
}

/** Browser sign-in against the Atlassian MCP authorization server, through the service's own routes. */
async function connectJiraWithOAuth() {
  const saved = await svc.post("/connections/jira/configure", { method: "oauth", fields: { siteUrl: ATLASSIAN_SITE } });
  expect(saved.test.message).toMatch(/sign in/i);
  const { url, redirectUri } = await svc.post("/connections/jira/oauth/start", { includeWrite: false });
  expect(url).toContain("code_challenge_method=S256");
  expect(url).toContain(encodeURIComponent(redirectUri));
  const authorize = await fetch(url, { redirect: "manual" });
  const callback = authorize.headers.get("location")!;
  expect(callback.startsWith(redirectUri)).toBe(true);
  const done = await fetch(callback, { redirect: "manual" });
  expect(done.status).toBe(302);
  expect(done.headers.get("location")).toMatch(/oauth=ok/);
  // Replaying the same callback fails: state is single use.
  const replay = await fetch(callback, { redirect: "manual" });
  expect(replay.headers.get("location")).toMatch(/oauth=error/);
}

beforeAll(async () => {
  fx = await startFixtureServer();
  installScenarios(fx, { selfEmail: "alex@example.com" });
  useFakeClaude(fx.url);
  process.env.JARVIS_TEST_ENDPOINTS = "1";
  process.env.JARVIS_FIXTURE_URL = fx.url;
  svc = await startTestService();
  await svc.post("/setup/identity", { name: "Alex", email: "alex@example.com", confirm: true });
});
afterAll(async () => {
  await svc.stop();
  await fx.close();
  delete process.env.JARVIS_TEST_ENDPOINTS;
  delete process.env.JARVIS_FIXTURE_URL;
});

describe("meeting preparation, team recall and pending replies through claude.ai connectors and Atlassian sign-in", () => {
  it("connects Google Calendar and Gmail through the claude.ai connectors, and Jira through Atlassian OAuth", async () => {
    await connectClaude("gcal");
    await connectClaude("gmail");
    await connectJiraWithOAuth();
    const conns = await svc.get("/connections");
    for (const kind of ["gcal", "gmail", "jira"]) expect(conns.find((c: any) => c.kind === kind).status).toBe("connected");
    expect(conns.find((c: any) => c.kind === "jira").account).toBe("alex@example.com");
    // Tokens are stored as credentials, never returned by the API.
    expect(JSON.stringify(conns)).not.toMatch(/atl-access|atl-refresh/);
  });

  it("an abandoned Atlassian sign-in does not replace the working client", async () => {
    // Pretend the stored client was registered for another port, so starting sign-in registers a new one.
    const rec = svc.app.connections.record("jira")!;
    const old = rec.settings.oauthClient as Record<string, unknown>;
    svc.app.connections.mergeSettings("jira", { oauthClient: { ...old, redirectUri: "http://127.0.0.1:1/api/v1/oauth/callback" } });
    const { url } = await svc.post("/connections/jira/oauth/start", { includeWrite: false });
    expect(new URL(url).searchParams.get("client_id")).not.toBe(old.clientId);
    // Never completed: the stored client is unchanged and the connection still works.
    expect((svc.app.connections.record("jira")!.settings.oauthClient as Record<string, unknown>).clientId).toBe(old.clientId);
    svc.app.connections.mergeSettings("jira", { oauthClient: old });
    expect((await svc.post("/connections/jira/test")).test).toMatchObject({ ok: true });
  });

  it("the briefing prepares meetings with related people notes and lists pending replies", async () => {
    await svc.post("/memory/save", { items: [{ action: "create", type: "person", title: "Mia Jensen", facts: [{ subject: "Role", value: "Design lead at the client; prefers async design review notes" }] }] });
    // Long enough to be indexed as several passages that all match the meeting.
    const passage = (n: number) => `Design review round ${n} with Mia Jensen. ${"Async design review notes and decisions. ".repeat(32)}`;
    await svc.post("/memory/save", { items: [{ action: "create", type: "note", title: "Design review log", facts: [{ subject: "Owner", value: "Mia Jensen" }], notes: [1, 2, 3].map(passage).join("\n\n") }] });
    const { job } = await svc.post("/briefings", { kind: "manual" });
    const done = await svc.waitJob(job.id);
    expect(done.job.status).toBe("succeeded");
    const b = (await svc.get("/briefings/latest")).briefing;
    const meetings = b.sections.find((s: any) => s.id === "meetings");
    const review = meetings.items.find((i: any) => i.title.includes("Design review"));
    expect(review).toBeTruthy();
    expect(review.related.map((r: any) => r.title)).toContain("Mia Jensen");
    // One chip per note: several matching passages of the same note collapse to its best one.
    for (const m of meetings.items) expect(new Set(m.related.map((r: any) => r.relPath)).size).toBe(m.related.length);
    expect(meetings.items.some((i: any) => /Offsite planning/.test(i.title))).toBe(true);
    // All-day events are not meeting prep.
    expect(JSON.stringify(b.sections)).not.toContain("Company holiday");
    const replies = b.sections.find((s: any) => s.id === "replies");
    expect(replies?.items.length ?? 0).toBeGreaterThan(0);
    // Calendar notification mails are never pending replies.
    expect(JSON.stringify(replies)).not.toContain("Invitation: Design review");
    expect(b.coverage.find((c: any) => c.kind === "gcal").coverage.state).toMatch(/complete|empty/);
    expect(b.deliverablePath).toMatch(/^deliverables\/briefings\//);
  });

  it("an away summary covers only what is new or changed since the given time", async () => {
    const since = new Date().toISOString();
    const { job } = await svc.post("/briefings", { kind: "away", since });
    await svc.waitJob(job.id);
    const away = (await svc.get("/briefings/latest")).briefing;
    expect(away.kind).toBe("away");
    const items = away.sections.filter((s: any) => !["prepared", "memory"].includes(s.id)).flatMap((s: any) => s.items);
    expect(items.every((i: any) => i.isNew || i.changed)).toBe(true);
    expect(away.counts.new).toBe(0);
  });
});
