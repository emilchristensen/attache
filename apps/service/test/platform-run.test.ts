import { describe, expect, it } from "vitest";
import { run } from "../src/platform/run.ts";

const HANG = ["-e", "setTimeout(() => {}, 30_000)"];

describe("run", () => {
  it("stops a tool when its signal is aborted, without calling it a timeout", async () => {
    const started = Date.now();
    const result = await run(process.execPath, HANG, { signal: AbortSignal.timeout(100) });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.code).not.toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toMatch(/abort/i);
  });

  it("does not start a tool whose signal is already aborted", async () => {
    const result = await run(process.execPath, ["-e", "process.stdout.write('ran')"], { signal: AbortSignal.abort() });
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});
