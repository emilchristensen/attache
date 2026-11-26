// A Job still working when the service stops: the service closes its database, and the Job runs again at the next start.
// Before the fix, a runner that settled after the stop wrote to the closed database and failed as an unhandled rejection.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JobContext } from "../../src/jobs/queue.ts";
import { startTestService } from "./harness.ts";

const failures: unknown[] = [];
const record = (e: unknown) => failures.push(e);
beforeEach(() => {
  failures.length = 0;
  process.on("unhandledRejection", record);
  process.on("uncaughtException", record);
});
afterEach(() => {
  process.off("unhandledRejection", record);
  process.off("uncaughtException", record);
});

/** Let pending promise callbacks and timers run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("a Job that outlives the service", () => {
  for (const [ending, end] of [
    ["finishes", (ctx: JobContext) => ({ step: ctx.checkpoint<{ step: number }>()?.step ?? 0 })],
    ["reports progress and fails", (ctx: JobContext) => {
      ctx.progress(0.5, "Halfway");
      throw new Error("the source went away");
    }],
  ] as const) {
    it(`${ending} after the stop without failing, and runs again at the next start`, async () => {
      const svc = await startTestService();
      let release!: () => void;
      const released = new Promise<void>((resolve) => (release = resolve));
      svc.app.jobs.register("demo-long", async (ctx) => {
        ctx.saveCheckpoint({ step: 2 });
        await released;
        return end(ctx);
      });
      const { job } = svc.app.jobs.create({ kind: "demo-long", title: "Research", input: { steps: 3, stepMs: 10, effectAtStep: 99 } });
      await svc.waitJob(job.id, ["running"]);
      await svc.stop();

      release();
      await settle();
      expect(failures).toEqual([]);

      const again = await startTestService({ stateDir: svc.stateDir, dataDir: svc.dataDir });
      try {
        const done = await again.waitJob(job.id);
        expect(done.job).toMatchObject({ status: "succeeded", result: { completedSteps: 3 } });
        expect(done.events.map((e: { type: string }) => e.type)).toContain("recovered");
      } finally {
        await again.stop();
      }
    });
  }
});
