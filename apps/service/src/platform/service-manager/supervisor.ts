import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { REFUSED_EXIT_CODE } from "./types.ts";

/** What the Windows logon task runs, and in which environment. */
export interface SupervisedService {
  /** The `attache-service.mjs` (or `main.ts` in development) to run `serve` from. */
  script: string;
  port: number;
  stateDir: string;
  instance: string;
  /** The owner's home folder and application data folders, as the installer saw them. */
  home: string;
  localAppData?: string;
  appData?: string;
  /** Where the service lists releases, when the installer was given an address (`ServiceSpec.releaseFeedUrl`). */
  releaseFeedUrl?: string;
}

const FIRST_DELAY_MS = 2_000;
const MAX_DELAY_MS = 60_000;
/** A service that ran this long before stopping gets the short delay again. */
const STEADY_MS = 60_000;
const STOP_WAIT_MS = 10_000;
const PARENT_CHECK_MS = 1_000;

/** Whether a process still exists (one of another user's processes counts). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The environment the service runs in: what launchd and systemd units set, which a scheduled task cannot. */
function serviceEnv(s: SupervisedService): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: s.home,
    USERPROFILE: s.home,
    ...(s.localAppData ? { LOCALAPPDATA: s.localAppData } : {}),
    ...(s.appData ? { APPDATA: s.appData } : {}),
    ATTACHE_STATE_DIR: s.stateDir,
    ATTACHE_INSTANCE: s.instance,
    ATTACHE_WEB_DIR: resolve(dirname(s.script), "..", "web"),
    ...(s.releaseFeedUrl ? { ATTACHE_RELEASE_FEED_URL: s.releaseFeedUrl } : {}),
  };
}

/**
 * Keep `attache serve` running, as launchd's KeepAlive and systemd's
 * Restart=always do on macOS and Linux: Task Scheduler starts a task at logon
 * but does not restart a program that exits. A service that refused to start
 * (`REFUSED_EXIT_CODE`) is not started again, and the supervisor ends.
 * The service's output is appended to `service.out.log` and
 * `service.err.log` in the state folder's `logs`. The service is started with
 * a channel back to this process and stops when that closes, so it never
 * outlives its supervisor. Resolves once the supervisor was asked to stop, or
 * the service refused to start, and the service has stopped.
 */
export function superviseService(s: SupervisedService): Promise<void> {
  const logs = join(s.stateDir, "logs");
  mkdirSync(logs, { recursive: true });
  const errLog = join(logs, "service.err.log");
  const note = (message: string) => appendFileSync(errLog, `${new Date().toISOString()} attache service run: ${message}\n`);
  let child: ChildProcess | null = null;
  let stopping = false;
  let delay = FIRST_DELAY_MS;
  let timer: NodeJS.Timeout | null = null;

  return new Promise((done) => {
    const start = () => {
      timer = null;
      const out = openSync(join(logs, "service.out.log"), "a");
      const err = openSync(errLog, "a");
      const startedAt = Date.now();
      // Detached, so that a supervisor killed outright (Windows has no SIGTERM) does not take the
      // service down with it mid-write: the closed channel asks the service to stop cleanly instead.
      const c = spawn(process.execPath, [...process.execArgv, s.script, "serve", "--port", String(s.port)], { env: serviceEnv(s), stdio: ["ignore", out, err, "ipc"], windowsHide: true, detached: true });
      closeSync(out);
      closeSync(err);
      child = c;
      c.on("error", (e) => note(`could not start the service: ${e.message}`));
      c.on("exit", (code, signal) => {
        child = null;
        if (stopping) return done();
        if (code === REFUSED_EXIT_CODE) {
          // Starting it again would only refuse again, so the supervisor ends, as systemd's RestartPreventExitStatus does.
          note("the service refused to start; it starts again with `attache start` or when Attache is installed again");
          stopping = true;
          clearInterval(watch);
          return done();
        }
        delay = Date.now() - startedAt >= STEADY_MS ? FIRST_DELAY_MS : delay;
        note(`the service stopped (${signal ? `signal ${signal}` : `exit code ${code}`}); starting it again in ${delay / 1000} s`);
        timer = setTimeout(start, delay);
        delay = Math.min(delay * 2, MAX_DELAY_MS);
      });
    };

    // Ending the task (Task Scheduler, logoff, `attache stop`) ends the console host that started this
    // process, not this process; so it watches that host and stops with it.
    const parent = process.ppid;
    const watch = setInterval(() => {
      if (!alive(parent)) stop("the task that started it has ended");
    }, PARENT_CHECK_MS);

    const stop = (why: string) => {
      if (stopping) return;
      stopping = true;
      clearInterval(watch);
      note(`stopping (${why})`);
      if (timer) clearTimeout(timer);
      if (!child) return done();
      // Closing the channel asks the service to shut down cleanly; Windows has no SIGTERM to send.
      const c = child;
      if (c.connected) c.disconnect();
      setTimeout(() => c.kill("SIGKILL"), STOP_WAIT_MS).unref();
    };
    for (const signal of ["SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK"] as const) process.on(signal, () => stop(signal));
    start();
  });
}
