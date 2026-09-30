import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { installScenarios } from "../fixtures/scenarios.ts";

let svc: TestService;
let fx: FixtureServer;

async function connectGoogle(kind: "gcal" | "gmail") {
  await svc.post(`/connections/${kind}/configure`, { method: "oauth", fields: { clientId: "fixture-client.apps.googleusercontent.com", clientSecret: "fixture-secret" } });
  const { url, redirectUri } = await svc.post(`/connections/${kind}/oauth/start`, { includeWrite: false });
  expect(url).toContain("code_challenge_method=S256");
  expect(url).toContain(encodeURIComponent(redirectUri));
  // The provider redirects the browser back to the service with a code and the state.
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

describe("meeting preparation, team recall and pending replies through real OAuth adapters", () => {
  it("connects Google Calendar and Gmail through the browser sign-in flow", async () => {
    await connectGoogle("gcal");
    await connectGoogle("gmail");
    const conns = await svc.get("/connections");
    expect(conns.find((c: any) => c.kind === "gcal").status).toBe("connected");
    expect(conns.find((c: any) => c.kind === "gmail").status).toBe("connected");
    // Tokens are stored as credentials, never returned by the API.
    expect(JSON.stringify(conns)).not.toMatch(/fixture-refresh|ya29\./);
  });

  it("the briefing prepares meetings with related people notes and lists pending replies", async () => {
    await svc.post("/memory/notes", { type: "person", title: "Mia Jensen", state: [{ subject: "Role", value: "Design lead at the client; prefers async design review notes" }] });
    const { job } = await svc.post("/briefings", { kind: "manual" });
    const done = await svc.waitJob(job.id);
    expect(done.job.status).toBe("succeeded");
    const b = (await svc.get("/briefings/latest")).briefing;
    const meetings = b.sections.find((s: any) => s.id === "meetings");
    const review = meetings.items.find((i: any) => i.title.includes("Design review"));
    expect(review).toBeTruthy();
    expect(review.related.map((r: any) => r.title)).toContain("Mia Jensen");
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
