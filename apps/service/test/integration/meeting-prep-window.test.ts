import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AttentionItemView } from "@attache/contracts";
import { brainFile, startTestService, type TestService } from "./harness.ts";
import { reviewPath } from "../../src/review-state/files.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { installScenarios, type ScenarioState } from "../fixtures/scenarios.ts";
import { useFakeClaude } from "../fixtures/claude-connectors.ts";
import { ManualClock } from "../fixtures/manual-clock.ts";

// Each refresh starts a fake Claude Code process, which is slow while other suites share the machine.
vi.setConfig({ testTimeout: 120_000 });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The service's clock: the calendar Connection and the Inbox both read the time from it. */
const START = Date.parse("2026-11-18T08:00:00.000Z");
const clock = new ManualClock(START);
const MEETING = { start: START + 2 * HOUR, end: START + 2 * HOUR + 30 * MINUTE };

let svc: TestService;
let fx: FixtureServer;
let scenario: ScenarioState;

beforeAll(async () => {
  fx = await startFixtureServer();
  scenario = installScenarios(fx, { selfEmail: "alex@example.com" }).state;
  scenario.gcal.events = [
    {
      id: "handover",
      summary: "Pilot handover",
      start: { dateTime: "2026-11-18T11:00:00+01:00" },
      end: { dateTime: "2026-11-18T11:30:00+01:00" },
      conferenceUrl: "https://meet.google.com/abc-defg-hij",
      attendees: [{ email: "alex@example.com", self: true, responseStatus: "accepted" }, { email: "nora@client.example", displayName: "Nora Lind", responseStatus: "accepted" }],
    },
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

async function meetingItem(states = "open,dismissed,snoozed,resolved"): Promise<AttentionItemView | undefined> {
  const { items } = await svc.get<{ items: AttentionItemView[] }>(`/attention?state=${states}`);
  return items.find((i) => i.key === "gcal:handover");
}

/** Move the service's clock to `at`, running its housekeeping on the way. */
const moveTo = (at: number) => clock.advance(at - clock.now().getTime());

describe("the calendar Connection's meeting prep window", () => {
  it("keeps the item open from 24 hours before the meeting until its scheduled end, carrying the start, end and Meet link", async () => {
    await refresh();
    const before = await meetingItem();
    expect(before).toMatchObject({
      kind: "meeting_prep",
      state: "open",
      url: "https://calendar.google.com/event?eid=handover",
      meeting: { start: "2026-11-18T10:00:00.000Z", end: "2026-11-18T10:30:00.000Z", meetLink: "https://meet.google.com/abc-defg-hij", attendees: ["Nora Lind"] },
    });

    // The meeting is part of the item's record in the Brain, so every Machine has it and works the end out alike.
    expect(JSON.parse(brainFile(svc, reviewPath("inbox", "gcal:handover"))).item.meeting).toEqual(before!.meeting);

    // Ten minutes into the meeting: still open, the same item.
    await moveTo(MEETING.start + 10 * MINUTE);
    await refresh();
    expect(await meetingItem("open")).toMatchObject({ id: before!.id, state: "open", meeting: before!.meeting });

    // A minute before the end, housekeeping leaves it open.
    await moveTo(MEETING.end - MINUTE);
    expect((await meetingItem())!.state).toBe("open");
  });

  it("resolves the item once the scheduled end has passed, with no Source refresh needed, and a later refresh does not bring it back", async () => {
    await moveTo(MEETING.end + MINUTE);
    expect(await meetingItem("open")).toBeUndefined();
    expect((await meetingItem())!.state).toBe("resolved");

    await refresh();
    expect((await meetingItem())!.state).toBe("resolved");
  });

  it("a meeting moved to later opens its item again, with the new times", async () => {
    scenario.gcal.events = scenario.gcal.events.map((e) => ({ ...e, start: { dateTime: "2026-11-18T14:00:00+01:00" }, end: { dateTime: "2026-11-18T15:00:00+01:00" } }));
    await refresh();
    expect(await meetingItem("open")).toMatchObject({ state: "open", meeting: { start: "2026-11-18T13:00:00.000Z", end: "2026-11-18T14:00:00.000Z" } });
  });
});
