import { execFile, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { win32 } from "node:path";
import { launchTool } from "./launch.ts";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  /** True when the tool was stopped because it ran past `timeoutMs`. */
  timedOut: boolean;
}

/**
 * Run an operating-system tool without a shell and report how it ended.
 * Never rejects: a tool that is missing, fails or is stopped by `signal`
 * gives a non-zero code, and the caller decides what that means.
 */
export function run(cmd: string, args: string[], opts: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}): Promise<RunResult> {
  let launch;
  try {
    launch = launchTool(cmd, args);
  } catch (e) {
    return Promise.resolve({ code: 1, stdout: "", stderr: (e as Error).message, timedOut: false });
  }
  return new Promise((resolve) => {
    const child = execFile(launch.command, launch.args, { maxBuffer: 1024 * 1024, windowsHide: true, ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}), ...(opts.env ? { env: opts.env } : {}), ...(opts.signal ? { signal: opts.signal } : {}) }, (error, stdout, stderr) => {
      const exited = error && typeof (error as { code?: unknown }).code === "number";
      const code = exited ? Number((error as { code: number }).code) : error ? 1 : 0;
      const timedOut = !!error && !!opts.timeoutMs && (error as { killed?: boolean }).killed === true;
      // A tool that ran and failed speaks for itself on stderr; one that could not run (missing, timed out) gets a reason of its own.
      const reason = timedOut ? `${win32.basename(cmd)} did not answer within ${opts.timeoutMs! / 1000} seconds` : error && !exited ? error.message : "";
      resolve({ code, stdout: String(stdout), stderr: String(stderr) || reason, timedOut });
    });
    // A tool that exits before reading all its input closes the pipe (EPIPE, or EOF on Windows); its exit code and stderr say why, so
    // the write's own error is left to them rather than thrown out of the service.
    child.stdin?.on("error", () => {});
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** How writing to a tool's stdin fails after the tool has gone: EPIPE on macOS and Linux, EOF on Windows. */
const CLOSED_INPUT = new Set(["EPIPE", "EOF"]);

/**
 * Why a `spawnSync` call could not run its tool, or undefined when the tool ran. A closed input is not such a reason:
 * the tool ran and exited before reading all its input, and its exit code and stderr say why.
 */
export function spawnFailure(r: SpawnSyncReturns<string>): NodeJS.ErrnoException | undefined {
  const error = r.error as NodeJS.ErrnoException | undefined;
  return error?.code && CLOSED_INPUT.has(error.code) ? undefined : error;
}

/**
 * `run`, waiting for the tool: for a short question to a tool (such as its
 * `--version`) from code that cannot wait asynchronously. Never throws.
 */
export function runSync(cmd: string, args: string[], opts: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): RunResult {
  let launch;
  try {
    launch = launchTool(cmd, args);
  } catch (e) {
    return { code: 1, stdout: "", stderr: (e as Error).message, timedOut: false };
  }
  const r = spawnSync(launch.command, launch.args, { encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: true, ...(opts.input !== undefined ? { input: opts.input } : {}), ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}), ...(opts.env ? { env: opts.env } : {}) });
  const failure = spawnFailure(r);
  const timedOut = !!opts.timeoutMs && failure?.code === "ETIMEDOUT";
  const reason = timedOut ? `${win32.basename(cmd)} did not answer within ${opts.timeoutMs! / 1000} seconds` : (failure?.message ?? "");
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr || reason, timedOut };
}
