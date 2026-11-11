/** An opaque timer handle, whatever the clock uses underneath. */
export type TimerHandle = { readonly __timer: unique symbol };

/**
 * Time as Replication sees it: the current time and timers. The service uses
 * the system clock; tests use a clock they move by hand, so a check that
 * would come a minute later runs the moment the test says so.
 */
export interface Clock {
  now(): Date;
  /** Run `fn` after `ms`. A promise `fn` returns is the work the timer started. */
  setTimeout(fn: () => unknown, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout(fn, ms) {
    const t = setTimeout(() => void fn(), ms);
    // A pending Replication check never keeps the process alive on its own.
    t.unref();
    return t as unknown as TimerHandle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as unknown as NodeJS.Timeout);
  },
};
