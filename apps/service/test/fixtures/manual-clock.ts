import type { Clock, TimerHandle } from "../../src/replication/clock.ts";

interface Timer {
  id: number;
  at: number;
  seq: number;
  fn: () => unknown;
}

/**
 * How a timer meets the wall clock on a real Machine. Node runs a timer by its event loop's clock, which can be a
 * few milliseconds ahead of the wall clock Attache reads, and the wall clock moves on while the timer's work runs.
 */
export interface TimerSkew {
  /** How long before its time a timer runs, by the wall clock. */
  leadMs: number;
  /** How much later each reading of the clock is than the one before, while a timer runs. */
  readStepMs: number;
}

/**
 * A clock that only moves when a test moves it. Timers fire in due order
 * during `advance`, which waits for any promise a timer callback returns, so
 * a test that advances past a Replication check sees the check finished.
 */
export class ManualClock implements Clock {
  private time: number;
  private timers: Timer[] = [];
  private nextId = 1;
  private seq = 0;
  private skew: TimerSkew = { leadMs: 0, readStepMs: 0 };
  private inTimer = false;

  constructor(start = Date.now()) {
    this.time = start;
  }

  now(): Date {
    const at = this.time;
    if (this.inTimer) this.time += this.skew.readStepMs;
    return new Date(at);
  }

  setTimeout(fn: () => unknown, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers = [...this.timers, { id, at: this.time + Math.max(0, ms), seq: this.seq++, fn }];
    return id as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers = this.timers.filter((t) => t.id !== (handle as unknown as number));
  }

  /**
   * Run timers as a real Machine can (see `TimerSkew`) from now on; `skewTimers({ leadMs: 0, readStepMs: 0 })`
   * goes back to running each timer exactly at its time.
   */
  skewTimers(skew: TimerSkew): void {
    this.skew = { ...skew };
  }

  /**
   * Move time forward by `ms` without running timers, as when a Machine was
   * asleep: what fell due runs at the next `advance`, once.
   */
  skip(ms: number): void {
    this.time += ms;
  }

  /** Move time forward by `ms`, running every timer that falls due on the way. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.time = Math.max(this.time, due.at - this.skew.leadMs);
      this.inTimer = true;
      try {
        await due.fn();
      } finally {
        this.inTimer = false;
      }
    }
    this.time = Math.max(this.time, end);
  }
}
