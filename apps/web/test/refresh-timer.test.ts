import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinedRefresh } from "../src/refresh-timer.ts";

describe("joinedRefresh", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs once, at the delay after the first request, however many requests join it", () => {
    const run = vi.fn();
    const refresh = joinedRefresh(run, 120);
    refresh.request();
    vi.advanceTimersByTime(50);
    // A later event joins the scheduled refresh instead of postponing it, so resources asked again on the same
    // event still start together.
    refresh.request();
    vi.advanceTimersByTime(70);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("schedules a new run for a request after the last one ran", () => {
    const run = vi.fn();
    const refresh = joinedRefresh(run, 120);
    refresh.request();
    vi.advanceTimersByTime(120);
    refresh.request();
    vi.advanceTimersByTime(119);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps running under a steady stream of requests, where a debounce would wait for quiet", () => {
    const run = vi.fn();
    const refresh = joinedRefresh(run, 120);
    for (let t = 0; t < 1000; t += 50) {
      refresh.request();
      vi.advanceTimersByTime(50);
    }
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it("runs nothing once cancelled", () => {
    const run = vi.fn();
    const refresh = joinedRefresh(run, 120);
    refresh.request();
    refresh.cancel();
    vi.advanceTimersByTime(500);
    expect(run).not.toHaveBeenCalled();
  });
});
