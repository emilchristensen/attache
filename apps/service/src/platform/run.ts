import { execFile } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run an operating-system tool without a shell and report how it ended.
 * Never rejects: a tool that is missing or fails gives a non-zero code, and
 * the caller decides what that means.
 */
export function run(cmd: string, args: string[], opts: { input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { maxBuffer: 1024 * 1024, ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}), ...(opts.env ? { env: opts.env } : {}) }, (error, stdout, stderr) => {
      const code = error && typeof (error as { code?: unknown }).code === "number" ? Number((error as { code: number }).code) : error ? 1 : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr || (error && !String(stderr) ? error.message : "")) });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}
