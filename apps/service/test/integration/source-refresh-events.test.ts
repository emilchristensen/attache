import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SOURCE_REFRESH_EVENT } from "@attache/contracts";
import { startTestService, type TestService } from "./harness.ts";

let svc: TestService;

beforeAll(async () => {
  svc = await startTestService();
});
afterAll(async () => {
  await svc.stop();
});

describe("a Source refresh's live events", () => {
  it("says when it starts and when it finishes, before the Inbox change that asks the count again", async () => {
    const events: Array<{ type: string; phase?: string }> = [];
    const listen = (e: { type: string; phase?: string }) => events.push(e);
    svc.app.bus.on("event", listen);
    try {
      await svc.waitJob((await svc.post("/jobs", { kind: "source-refresh", input: { all: true } })).job.id);
    } finally {
      svc.app.bus.off("event", listen);
    }
    const seen = events.filter((e) => e.type === SOURCE_REFRESH_EVENT || e.type === "attention.changed").map((e) => (e.phase ? `${e.type}:${e.phase}` : e.type));
    expect(seen.slice(0, 1)).toEqual([`${SOURCE_REFRESH_EVENT}:started`]);
    expect(seen.slice(-2)).toEqual([`${SOURCE_REFRESH_EVENT}:finished`, "attention.changed"]);
  });
});
