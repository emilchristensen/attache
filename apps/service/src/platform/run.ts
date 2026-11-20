import { execFile, spawnSync } from "node:child_process";
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
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/**
 * `run`, waiting for the tool: for a short question to a tool (such as its
 * `--version`) from code that cannot wait asynchronously. Never throws.
 */
export function runSync(cmd: string, args: string[], opts: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): RunResult {
  let launch;
  try {
    launch = launchTool(cmd, args);
  } catch (e) {
    return { code: 1, stdout: "", stderr: (e as Error).message, timedOut: false };
  }
  const r = spawnSync(launch.command, launch.args, { encoding: "utf8", maxBuffer: 1024 * 1024, windowsHide: true, ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}), ...(opts.env ? { env: opts.env } : {}) });
  const timedOut = !!opts.timeoutMs && (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const reason = timedOut ? `${win32.basename(cmd)} did not answer within ${opts.timeoutMs! / 1000} seconds` : (r.error?.message ?? "");
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr || reason, timedOut };
}
