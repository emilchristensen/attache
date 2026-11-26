/**
 * Waiting for Jobs (spec #130, "Updater"): Automatic updates installs a
 * verified Update only once no Job is running, so an Update does not cut
 * into research or a briefing. It looks again whenever a Job changes and at
 * least every minute, and stops waiting after 24 hours, so a Machine that is
 * always busy still gets Updates.
 */
import type { Clock, TimerHandle } from "../replication/clock.ts";

/** How often the wait looks at the running Jobs, besides each time a Job changes. */
export const JOB_LOOK_MS = 60_000;
/** How long an Update waits for Jobs before it installs anyway. */
export const JOB_WAIT_LIMIT_MS = 24 * 60 * 60_000;

/** The Jobs on this Machine, as the wait sees them. */
export interface RunningJobs {
  /** How many Jobs are running now. */
  count(): number;
  /** Call `listener` whenever any Job changes; the returned function stops that. */
  onChange(listener: () => void): () => void;
}

export interface JobWaitOptions {
  clock: Clock;
  jobs: RunningJobs;
  /** The number of running Jobs changed, and is still above zero. */
  onCount: (count: number) => void;
  /** No Job runs any more, or the wait reached its limit: install now. Called once; what it returns is awaited by the clock's timer. */
  onClear: () => Promise<unknown>;
}

/** A wait that has begun because Jobs were running. `cancel` ends it without `onClear`, as Restart now or a change of mode does. */
export class JobWait {
  private readonly opts: JobWaitOptions;
  private readonly since: number;
  private timer: TimerHandle | null = null;
  private stopListening: (() => void) | null;
  private last: number;
  private done = false;

  /** Begin waiting while `running` Jobs run (above zero). */
  constructor(opts: JobWaitOptions, running: number) {
    this.opts = opts;
    this.since = opts.clock.now().getTime();
    this.last = running;
    this.stopListening = opts.jobs.onChange(() => void this.look());
    this.arm();
  }

  cancel(): void {
    this.done = true;
    if (this.timer) this.opts.clock.clearTimeout(this.timer);
    this.timer = null;
    this.stopListening?.();
    this.stopListening = null;
  }

  private look(): Promise<unknown> | undefined {
    if (this.done) return undefined;
    const running = this.opts.jobs.count();
    const waited = this.opts.clock.now().getTime() - this.since;
    if (running === 0 || waited >= JOB_WAIT_LIMIT_MS) {
      this.cancel();
      return this.opts.onClear();
    }
    if (running !== this.last) {
      this.last = running;
      this.opts.onCount(running);
    }
    if (!this.timer) this.arm();
    return undefined;
  }

  private arm(): void {
    const left = this.since + JOB_WAIT_LIMIT_MS - this.opts.clock.now().getTime();
    this.timer = this.opts.clock.setTimeout(() => {
      this.timer = null;
      return this.look();
    }, Math.max(0, Math.min(JOB_LOOK_MS, left)));
  }
}
