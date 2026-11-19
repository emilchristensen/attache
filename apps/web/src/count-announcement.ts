import { useEffect, useRef, useState } from "react";
import { SOURCE_REFRESH_EVENT } from "@attache/contracts";
import { refreshAnnouncement, type Tally } from "./count.ts";
import { orderMark, useLiveEvent } from "./live.ts";
import { needYou } from "./nav-signals.ts";

/** A Source refresh under way: the total when it started, and the mark taken when it finished (null until then). */
interface Refresh {
  before: Tally;
  finishedAt: number | null;
}

/**
 * The words a screen reader hears when a Source refresh changed the decision count (spec #14 story 22), for the
 * shell's polite status region: the total when the refresh started is compared with the first count asked after it
 * finished. The first load, the owner's own decisions and every other live update stay quiet. The same words twice
 * in a row differ by a trailing no-break space, so the region announces them again.
 */
export function useRefreshAnnouncement(total: Tally, askedAt: number | null): string {
  const [said, setSaid] = useState("");
  const latest = useRef(total);
  const refresh = useRef<Refresh | null>(null);
  useEffect(() => {
    latest.current = total;
  });
  useLiveEvent((ev) => {
    if (ev.type !== SOURCE_REFRESH_EVENT) return;
    if (ev.phase === "started" && !refresh.current) refresh.current = { before: latest.current, finishedAt: null };
    if (ev.phase === "finished" && refresh.current) refresh.current = { ...refresh.current, finishedAt: orderMark() };
  });
  useEffect(() => {
    const r = refresh.current;
    if (!r || r.finishedAt === null || askedAt === null || askedAt < r.finishedAt) return;
    refresh.current = null;
    const words = refreshAnnouncement(r.before, total, needYou);
    if (words) setSaid((last) => (last === words ? `${words} ` : words));
  }, [total, askedAt]);
  return said;
}
