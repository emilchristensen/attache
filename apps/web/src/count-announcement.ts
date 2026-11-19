import { useEffect, useRef, useState } from "react";
import { SOURCE_REFRESH_EVENT } from "@attache/contracts";
import { refreshAnnouncement, type Tally } from "./count.ts";
import { orderMark, useLiveEvent } from "./live.ts";
import { needYou } from "./nav-signals.ts";

/**
 * The words a screen reader hears when a Source refresh changed what counts (spec #14 story 22), for the shell's
 * polite status region. The service says whether the refresh itself opened, reopened or resolved an Inbox item or
 * changed a sign-in (`SOURCE_REFRESH_EVENT`), so the owner's own decisions and every other live update, and the
 * first load, stay quiet; the total read out is the first count asked after that event. The same words twice in a
 * row differ by a trailing no-break space, so the region announces them again.
 */
export function useRefreshAnnouncement(total: Tally, askedAt: number | null): string {
  const [said, setSaid] = useState("");
  // The mark taken when a refresh that changed something finished; null while none waits to be read out.
  const due = useRef<number | null>(null);
  useLiveEvent((ev) => {
    if (ev.type === SOURCE_REFRESH_EVENT && ev.changed === true && due.current === null) due.current = orderMark();
  });
  useEffect(() => {
    if (due.current === null || askedAt === null || askedAt < due.current) return;
    due.current = null;
    const words = refreshAnnouncement(total, needYou);
    if (words) setSaid((last) => (last === words ? `${words}\u00a0` : words));
  }, [total, askedAt]);
  return said;
}
