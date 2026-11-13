/**
 * One temporary folder per test run (Vitest, the browser journeys), removed when the run ends.
 * For the run, TMPDIR, TMP and TEMP point at it, so every folder a test, a test service or a
 * child process makes with os.tmpdir() lands inside it, and nothing is left behind in the
 * system's temporary folder.
 *
 * A run that is killed never removes its folder; the next run removes it, once the process
 * that made it (its id is in the folder's name) has exited. Runs going on at the same time,
 * say in two worktrees, keep theirs.
 *
 * On CI the run first copies its services' logs to test-results/service-logs, for the job to
 * upload after a failure.
 */
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { collectServiceLogs } from "./service-logs.mjs";

const PREFIX = "jarvis-run-";
// TMPDIR on macOS and Linux; TEMP, then TMP, on Windows.
const TEMP_VARIABLES = ["TMPDIR", "TMP", "TEMP"];
const SERVICE_LOGS = resolve(import.meta.dirname, "..", "test-results", "service-logs");

/** Whether a process with this id is running. EPERM: it is, as another user. */
function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function remove(folder) {
  try {
    rmSync(folder, { recursive: true, force: true, maxRetries: 5 });
  } catch (e) {
    // A file a test service still holds open on Windows; the next run tries again.
    console.warn(`Could not remove the test run folder ${folder}: ${e.message}`);
  }
}

/** Remove the run folders in `base` whose run has exited. Returns the folders removed. */
export function removeLeftRunFolders(base) {
  const removed = [];
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith(PREFIX)) continue;
    const pid = Number(e.name.slice(PREFIX.length).split("-")[0]);
    if (Number.isInteger(pid) && pid > 0 && isRunning(pid)) continue;
    remove(join(base, e.name));
    removed.push(e.name);
  }
  return removed;
}

/**
 * Make this run's folder in `base` and point `env`'s temporary-folder variables at it.
 * `close()` restores them and removes the folder, after copying its service logs out when `env.CI` is set.
 */
export function openRunFolder({ base = tmpdir(), env = process.env, pid = process.pid, logsOut = SERVICE_LOGS } = {}) {
  removeLeftRunFolders(base);
  const folder = mkdtempSync(join(base, `${PREFIX}${pid}-`));
  const before = Object.fromEntries(TEMP_VARIABLES.map((name) => [name, env[name]]));
  for (const name of TEMP_VARIABLES) env[name] = folder;

  const close = () => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    if (env.CI) collectServiceLogs({ tmp: folder, out: join(logsOut, basename(folder)) });
    remove(folder);
  };
  return { folder, close };
}

/** Vitest's and Playwright's global setup: the returned function is the global teardown. */
export default function setup() {
  return openRunFolder().close;
}
