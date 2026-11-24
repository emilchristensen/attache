import { statSync } from "node:fs";
import { run, runSync } from "../platform/run.ts";

/**
 * What a Harness executable prints for `--version`, asked once per
 * executable and remembered until the file changes, failures included, so a
 * broken executable is not asked again on every status check.
 */

export interface VersionAnswer {
  /** What it printed, or null when it could not run or exited non-zero. */
  output: string | null;
  /** Why it could not answer (its stderr, a timeout, or its exit code); "" when it answered. */
  failure: string;
}

const TIMEOUT_MS = 15_000;
const answers = new Map<string, { stamp: string; answer: VersionAnswer }>();
const asking = new Map<string, string>();

const stampOf = (path: string) => {
  const { mtimeMs, size } = statSync(path);
  return `${mtimeMs}:${size}`;
};

const answerOf = (r: { code: number; stdout: string; stderr: string }): VersionAnswer => (r.code === 0 ? { output: r.stdout.trim(), failure: "" } : { output: null, failure: r.stderr.trim() || `exit ${r.code}` });

/**
 * The executable's answer. With `wait`, it is asked now when not known (a
 * connect, which may wait). Without, nothing ever waits: an unknown answer is
 * undefined, and the executable is asked in the background for next time
 * (status checks and refreshes, which run on the service's event loop).
 */
export function versionAnswer(path: string, env: NodeJS.ProcessEnv, opts: { wait: boolean }): VersionAnswer | undefined {
  const stamp = stampOf(path);
  const known = answers.get(path);
  if (known?.stamp === stamp) return known.answer;
  if (opts.wait) {
    const answer = answerOf(runSync(path, ["--version"], { timeoutMs: TIMEOUT_MS, env }));
    answers.set(path, { stamp, answer });
    return answer;
  }
  if (asking.get(path) !== stamp) {
    asking.set(path, stamp);
    void run(path, ["--version"], { timeoutMs: TIMEOUT_MS, env }).then((r) => {
      if (asking.get(path) === stamp) asking.delete(path);
      // A connect that waited meanwhile already knows; never replace a newer answer.
      if (answers.get(path)?.stamp !== stamp) answers.set(path, { stamp, answer: answerOf(r) });
    });
  }
  return undefined;
}

/** The first `major.minor.patch` in a version output, which may carry a product name or an update notice around it. */
export function firstVersion(output: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
