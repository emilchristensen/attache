import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { installScenarios } from "../fixtures/scenarios.ts";
import { useFakeClaude, type ClaudeFixture } from "../fixtures/claude-connectors.ts";

// Each test starts many fake Claude Code processes one after another, which is slow while other suites share the machine.
vi.setConfig({ testTimeout: 120_000 });

let svc: TestService;
let fx: FixtureServer;
let claude: ClaudeFixture;

const slackServer = () => claude.servers.find((s) => s.name === "claude.ai Slack")!;
const slack = async () => (await svc.get("/connections")).find((c: { kind: string }) => c.kind === "slack");
const syncJobs = async () => (await svc.get("/jobs")).filter((j: { kind: string; connectionId?: string }) => j.kind === "source-refresh" && j.connectionId === "slack");

beforeAll(async () => {
  fx = await startFixtureServer();
  ({ claude } = installScenarios(fx, { selfEmail: "alex@example.com" }));
  useFakeClaude(fx.url);
  svc = await startTestService();
  await svc.post("/setup/identity", { name: "Alex", email: "alex@example.com", confirm: true });
});
afterAll(async () => {
  await svc.stop();
  await fx.close();
});

describe("a connection that recovers its sign-in", () => {
  it("refreshes right after a successful test, so the card no longer shows the failed sync", async () => {
    expect((await svc.post("/connections/slack/configure", { method: "claude-ai", fields: {} })).test).toMatchObject({ ok: true });

    slackServer().status = "needs-auth";
    await svc.waitJob((await svc.post("/connections/slack/refresh")).job.id);
    expect(await slack()).toMatchObject({ status: "needs_auth", coverage: { state: "unauthorized" } });
    const before = (await syncJobs()).length;

    // A failed test starts nothing.
    expect((await svc.post("/connections/slack/test")).test.ok).toBe(false);
    expect(await syncJobs()).toHaveLength(before);

    slackServer().status = "connected";
    expect((await svc.post("/connections/slack/test")).test.ok).toBe(true);
    const jobs = await syncJobs();
    expect(jobs).toHaveLength(before + 1);
    await svc.waitJob(jobs[0].id);
    expect((await slack()).coverage.state).not.toBe("unauthorized");

    // Testing a connection that was already connected does not start another refresh.
    await svc.post("/connections/slack/test");
    expect(await syncJobs()).toHaveLength(before + 1);
  });

  it("refreshes after saving the method again, as Reconnect does for a login made outside Attache", async () => {
    slackServer().status = "needs-auth";
    await svc.waitJob((await svc.post("/connections/slack/refresh")).job.id);
    expect(await slack()).toMatchObject({ status: "needs_auth", coverage: { state: "unauthorized" } });
    const before = (await syncJobs()).length;

    slackServer().status = "connected";
    expect((await svc.post("/connections/slack/configure", { method: "claude-ai", fields: {} })).test).toMatchObject({ ok: true });
    const jobs = await syncJobs();
    expect(jobs).toHaveLength(before + 1);
    await svc.waitJob(jobs[0].id);
    expect((await slack()).coverage.state).not.toBe("unauthorized");
  });

  it("keeps when a Source refresh last read the source apart from when a sign-in test last passed", async () => {
    const read = (await slack()).lastReadAt as string;
    expect(read).toEqual(expect.any(String));
    slackServer().status = "needs-auth";
    await svc.waitJob((await svc.post("/connections/slack/refresh")).job.id);
    expect((await slack()).lastReadAt).toBe(read);
    slackServer().status = "connected";
    await svc.post("/connections/slack/test");
    const after = await slack();
    expect(after.lastSuccessAt > read).toBe(true);
    expect(after.lastReadAt).toBe(read);
  });
});
