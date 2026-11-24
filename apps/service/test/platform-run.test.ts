import { describe, expect, it } from "vitest";
import { run, runSync } from "../src/platform/run.ts";

const HANG = ["-e", "setTimeout(() => {}, 30_000)"];
/** A tool that fails at once without reading its input, as `secret-tool` does when there is no D-Bus. */
const REFUSES = ["-e", "process.stderr.write('Cannot autolaunch D-Bus without X11 $DISPLAY\\n'); process.exit(1)"];
/** More than a pipe holds, so writing it to a tool that has gone always fails with EPIPE. */
const LARGE_INPUT = "x".repeat(4 * 1024 * 1024);

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

describe("a tool that exits without reading its input", () => {
  it("run reports the tool's own failure, not the broken pipe", async () => {
    const result = await run(process.execPath, REFUSES, { input: LARGE_INPUT });
    expect(result).toEqual({ code: 1, stdout: "", stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY\n", timedOut: false });
  });

  it("runSync reports the tool's own failure, not the broken pipe", () => {
    const result = runSync(process.execPath, REFUSES, { input: LARGE_INPUT });
    expect(result).toEqual({ code: 1, stdout: "", stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY\n", timedOut: false });
    // A tool that says nothing is not given the pipe's error as its words.
    expect(runSync(process.execPath, ["-e", "process.exit(3)"], { input: LARGE_INPUT })).toEqual({ code: 3, stdout: "", stderr: "", timedOut: false });
  });
});
