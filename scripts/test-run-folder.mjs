/**
 * One temporary folder per test run (Vitest, the browser journeys), removed when the run ends.
 * For the run, TMPDIR, TMP and TEMP point at it, so every folder a test, a test service or a
 * child process makes with os.tmpdir() lands inside it, and nothing is left behind in the
 * system's temporary folder.
 *
 * A run that is killed never removes its folder; the next run removes it, once the process
 * that made it (its id is in the folder's name) has exited. Runs going on at the same time,
 * say in two worktrees, keep theirs. A process id means something only in its own process
 * namespace, so on Linux the name carries the namespace too, and a run in another one (another
 * sandbox sharing the temporary folder), whose process this run cannot see, keeps its folder
 * until nothing has changed in it for `STALE_RUN_MS`.
 *
 * On CI the run first copies its services' logs to test-results/service-logs, for the job to
 * upload after a failure.
 */
import { mkdtempSync, readdirSync, readlinkSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { collectServiceLogs } from "./service-logs.mjs";

const PREFIX = "attache-run-";
/** A run folder's name: the process id, on Linux its process namespace, then mkdtemp's random suffix. */
const RUN_FOLDER = /^attache-run-(\d+)(?:\.(\d+))?-/;
/** How long a run folder of another process namespace stays after its last change; no run lasts that long. */
export const STALE_RUN_MS = 24 * 60 * 60 * 1000;
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

/** This process's process namespace on Linux (the number in `pid:[4026531836]`), or null where there is none to read. */
export function pidNamespace() {
  try {
    return /^pid:\[(\d+)\]$/.exec(readlinkSync("/proc/self/ns/pid"))?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Whether the run that made the folder `name` in `base` has ended, as far as this process can tell. */
function runEnded(base, name, namespace, now) {
  const m = RUN_FOLDER.exec(name);
  if (!m) return true;
  // Another namespace's process ids are not this one's: its run is over only once its folder has gone quiet.
  if ((m[2] ?? null) !== namespace) return now - statSync(join(base, name)).mtimeMs > STALE_RUN_MS;
  return !isRunning(Number(m[1]));
}

/** Remove the run folders in `base` whose run has ended. Returns the folders removed. */
export function removeLeftRunFolders(base, { namespace = pidNamespace(), now = Date.now() } = {}) {
  const removed = [];
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || !e.name.startsWith(PREFIX)) continue;
    if (!runEnded(base, e.name, namespace, now)) continue;
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
  const namespace = pidNamespace();
  removeLeftRunFolders(base, { namespace });
  const folder = mkdtempSync(join(base, `${PREFIX}${pid}${namespace ? `.${namespace}` : ""}-`));
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
