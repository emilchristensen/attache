import type { Clock, TimerHandle } from "../../src/replication/clock.ts";

interface Timer {
  id: number;
  at: number;
  seq: number;
  fn: () => unknown;
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

  constructor(start = Date.now()) {
    this.time = start;
  }

  now(): Date {
    return new Date(this.time);
  }

  setTimeout(fn: () => unknown, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers = [...this.timers, { id, at: this.time + Math.max(0, ms), seq: this.seq++, fn }];
    return id as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers = this.timers.filter((t) => t.id !== (handle as unknown as number));
  }

  /** Move time forward by `ms`, running every timer that falls due on the way. */
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers].filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.seq - b.seq)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t.id !== due.id);
      this.time = Math.max(this.time, due.at);
      await due.fn();
    }
    this.time = end;
  }
}
