import { useEffect, useState } from "react";
import { useSignals } from "./nav-signals.ts";
import { HEADS_UP_TICK_MS, MEETING_LEAD_MS } from "./heads-up-rules.ts";

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
      // On the minute, so a meeting that starts at 14:00 shows as started at 14:00 and not up to a minute later.
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

/**
 * Home's one clock, shared by its areas (For you now, Your day, the Inbox) so a meeting leaves them at the same instant.
 * It reads the time at the boundaries of every meeting the open Inbox has listed while Home is open, also one that a
 * later answer no longer lists while For you now still holds it, so no Join outlasts its meeting.
 */
export function useHomeClock(): HeadsUpClock {
  const items = useSignals().openInbox.data?.items ?? null;
  const [seen, setSeen] = useState<readonly number[]>([]);
  const clock = useHeadsUpClock(seen);
  // Kept until the clock has read them: one that an answer brings just after it passed is read at once, not a minute on.
  useEffect(() => {
    const fresh = meetingBoundaries(items);
    setSeen((prev) => {
      const next = [...new Set([...prev, ...fresh])].filter((b) => b > clock.now).sort((a, b) => a - b);
      return next.length === prev.length && next.every((b, n) => b === prev[n]) ? prev : next;
    });
  }, [items, clock.now]);
  return clock;
}
