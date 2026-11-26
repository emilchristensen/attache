import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

/** How long one try takes: a process start, or a settle of background state, on a loaded runner. */
const SLOW_TRY_MS = 700;

describe("expect.poll's default deadline (vitest.config.ts)", () => {
  // Polls that start a process per try (a hook, a CLI) or wait for state the service settles in the
  // background rely on the shared default, not a per-call timeout. Vitest's own 1 s left them one try
  // under a full parallel run (#53, #142's Copilot CLI session-start hook).
  it("outlasts several slow tries", async () => {
    let tries = 0;
    await expect
      .poll(async () => {
        await delay(SLOW_TRY_MS);
        tries += 1;
        return tries;
      })
      .toBeGreaterThanOrEqual(3);
  });
});
