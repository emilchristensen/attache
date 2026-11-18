import { useEffect, useState } from "react";
import { HEADS_UP_TICK_MS } from "./heads-ups.ts";

export interface HeadsUpClock {
  now: number;
  timeZone: string;
}

function read(): HeadsUpClock {
  return { now: Date.now(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

/**
 * The instant and the browser's zone For you now is computed for: read again on every minute boundary, and when the
 * page becomes visible or the window gets focus, so a laptop that wakes or lands in another zone shows the right
 * Heads-ups straight away.
 */
export function useHeadsUpClock(): HeadsUpClock {
  const [clock, setClock] = useState(read);
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
  return clock;
}
