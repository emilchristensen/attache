import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgendaResponse, AttentionItemView } from "@attache/contracts";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { installScenarios, type ScenarioState } from "../fixtures/scenarios.ts";
import { useFakeClaude } from "../fixtures/claude-connectors.ts";
import { ManualClock } from "../fixtures/manual-clock.ts";

// Each refresh starts a fake Claude Code process, which is slow while other suites share the machine.
vi.setConfig({ testTimeout: 120_000 });

/** 08:00 UTC: before the day's meetings. */
const MORNING = Date.parse("2026-11-18T08:00:00.000Z");
/** 17:00 UTC: after the last meeting, with nothing tomorrow. */
const EVENING = Date.parse("2026-11-18T17:00:00.000Z");
const clock = new ManualClock(MORNING);
const attendees = [{ email: "alex@example.com", self: true, responseStatus: "accepted" }, { email: "nora@client.example", displayName: "Nora Lind", responseStatus: "accepted" }];

let svc: TestService;
let fx: FixtureServer;
let scenario: ScenarioState;

beforeAll(async () => {
  fx = await startFixtureServer();
  scenario = installScenarios(fx, { selfEmail: "alex@example.com" }).state;
  scenario.gcal.events = [
    { id: "standup", summary: "Standup", start: { dateTime: "2026-11-18T09:00:00Z" }, end: { dateTime: "2026-11-18T09:15:00Z" }, attendees },
    { id: "review", summary: "Design review", start: { dateTime: "2026-11-18T14:00:00Z" }, end: { dateTime: "2026-11-18T15:00:00Z" }, attendees: [{ email: "alex@example.com", self: true, responseStatus: "needsAction" }, attendees[1]!] },
  ];
  useFakeClaude(fx.url);
  process.env.ATTACHE_TEST_ENDPOINTS = "1";
  process.env.ATTACHE_FIXTURE_URL = fx.url;
  svc = await startTestService({ clock });
  await svc.post("/setup/identity", { name: "Alex", email: "alex@example.com", confirm: true });
  expect((await svc.post("/connections/gcal/configure", { method: "claude-ai", fields: {} })).test).toMatchObject({ ok: true });
});
afterAll(async () => {
  await svc.stop();
  await fx.close();
  delete process.env.ATTACHE_TEST_ENDPOINTS;
  delete process.env.ATTACHE_FIXTURE_URL;
});

async function refresh(): Promise<void> {
  const { job } = await svc.post("/connections/gcal/refresh");
  expect((await svc.waitJob(job.id)).job.status).toBe("succeeded");
}

/** Today in the widest zone a browser can be in, as Your day asks for it. */
const today = () => svc.get<AgendaResponse>("/agenda?from=2026-11-17T10:00:00.000Z&to=2026-11-19T12:00:00.000Z");

describe("the agenda after a Source refresh", () => {
  it("keeps today's meetings that have ended, read before or only after they ended, so Your day can say Nothing more today", async () => {
    await refresh();
    expect((await today()).events.map((e) => e.id)).toEqual(["standup", "review"]);

    await clock.advance(EVENING - MORNING);
    await refresh();
    const evening = await today();
    expect(evening.coverage).toMatchObject({ state: "complete" });
    expect(evening.events.map((e) => e.id)).toEqual(["standup", "review"]);

    // A meeting first read after it ended is listed too.
    scenario.gcal.events = [...scenario.gcal.events, { id: "lunch", summary: "Lunch talk", start: { dateTime: "2026-11-18T12:00:00Z" }, end: { dateTime: "2026-11-18T13:00:00Z" }, attendees }];
    await refresh();
    expect((await today()).events.map((e) => e.id)).toEqual(["standup", "lunch", "review"]);
  });

  it("raises nothing for a meeting that has ended: no prep, and no invitation to answer", async () => {
    const { items } = await svc.get<{ items: AttentionItemView[] }>("/attention?state=open");
    expect(items.filter((i) => i.key.startsWith("gcal:"))).toEqual([]);
  });
});
