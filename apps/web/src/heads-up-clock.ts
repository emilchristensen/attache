import { useEffect, useState } from "react";
import { HEADS_UP_TICK_MS, MEETING_LEAD_MS } from "./heads-ups.ts";

export interface HeadsUpClock {
  now: number;
  timeZone: string;
}

function read(at = Date.now()): HeadsUpClock {
  return { now: at, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

/** The instants a meeting prep item changes on Home: its Heads-up comes, its meeting starts, and it ends. */
export function meetingBoundaries(items: readonly { meeting?: { start: string; end: string } | null }[] | null): number[] {
  return (items ?? []).flatMap((i) => (i.meeting ? [Date.parse(i.meeting.start) - MEETING_LEAD_MS, Date.parse(i.meeting.start), Date.parse(i.meeting.end)] : []));
}

/**
 * The instant and the browser's zone For you now is computed for: read again on every minute boundary, at each of
 * `boundaries` (instants that fall between minutes, such as a meeting that ends at 10:30:20), and when the page
 * becomes visible or the window gets focus, so a laptop that wakes or lands in another zone shows the right Heads-ups
 * straight away, and no Join outlasts its meeting.
 */
export function useHeadsUpClock(boundaries: readonly number[] = []): HeadsUpClock {
  const [clock, setClock] = useState(() => read());
  useEffect(() => {
    let timer = 0;
    const tick = () => {
      setClock(read());
      window.clearTimeout(timer);
      // On the minute, so noon arrives at 12:00 and not up to a minute later.
      timer = window.setTimeout(tick, HEADS_UP_TICK_MS - (Date.now() % HEADS_UP_TICK_MS) + 50);
    };
    const visible = () => {
      if (document.visibilityState === "visible") tick();
    };
    tick();
    document.addEventListener("visibilitychange", visible);
    window.addEventListener("focus", tick);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
      window.removeEventListener("focus", tick);
    };
  }, []);
  // The next boundary after the clock's instant, read at exactly that instant (a timer can fire a little early).
  const next = Math.min(...boundaries.filter((b) => b > clock.now));
  useEffect(() => {
    if (!Number.isFinite(next)) return;
    const timer = window.setTimeout(() => setClock(read(Math.max(Date.now(), next))), Math.max(0, next - Date.now()));
    return () => window.clearTimeout(timer);
  }, [next]);
  return clock;
}
