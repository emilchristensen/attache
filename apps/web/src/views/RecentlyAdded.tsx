import { useEffect } from "react";
import { plural, UNREVIEWED_DAYS, type RecentChangeView, type RecentChangesResult } from "@attache/contracts";
import { useResource } from "../live.ts";
import { ChangeRow } from "../components/RecentChange.tsx";
import { useCollapsedList } from "../components/collapsed-list.tsx";
import { Disclosure } from "../components/Disclosure.tsx";
import { GroupFailure } from "../components/GroupFailure.tsx";

const NOTHING = `Nothing was written without your review in the last ${UNREVIEWED_DAYS} days.`;

/**
 * Every change written to the Brain without the owner reviewing it in the last 7 days (ADR 0004): auto-accepted
 * saves and Consolidation's changes, newest first, each with its source and a one-click revert. Home shows it as one
 * line closing the Inbox area that opens in place; nothing there asks for a decision, so it stays closed until the owner
 * looks. Older entries drop off on their own, so there is nothing to mark as seen. A failed request says so with
 * Retry (and keeps the entries it had), never "nothing".
 */
export function RecentlyAdded() {
  const res = useResource<RecentChangesResult>("/memory/recent-changes?unreviewed=1", ["memory.changed"]);
  const changes = res.data?.changes ?? [];
  const { shown, toggle } = useCollapsedList(changes);
  const expires = firstExpiry(changes);
  const { reload } = res;
  // Home may stay open for days: reload when the oldest entry leaves the window, so it drops off on its own.
  useEffect(() => {
    if (expires === null) return;
    const timer = window.setTimeout(reload, Math.max(0, expires - Date.now()));
    return () => window.clearTimeout(timer);
  }, [expires, reload]);
  const failed = res.error !== null;
  return (
    <section className="recently-added" aria-label="Recently added" data-recently-added>
      {failed && <GroupFailure what="Recently added" error={res.error!} answeredAt={res.answeredAt} retry={res.reload} retained={res.data !== null} />}
      {changes.length > 0 ? (
        <Disclosure title="Recently added" meta={`${plural(changes.length, "change")} written without your review in the last ${UNREVIEWED_DAYS} days`}>
          <ul className="recent-changes">
            {shown.map((c) => (
              <ChangeRow key={c.id} c={c} onReverted={res.reload} home />
            ))}
          </ul>
          {toggle}
        </Disclosure>
      ) : (
        !failed && (
          <p className="recently-added-line">
            <span className="disclosure-title">Recently added</span>
            <span className="disclosure-meta">{res.data ? NOTHING : "Checking what was written without your review."}</span>
          </p>
        )
      )}
    </section>
  );
}

/** One second past the window's end, so the service has left the entry out by then. */
const PAST_WINDOW_MS = 1000;

/** When the oldest entry turns {@link UNREVIEWED_DAYS} days old, in epoch milliseconds; null with no entries. */
function firstExpiry(changes: readonly RecentChangeView[]): number | null {
  if (!changes.length) return null;
  const oldest = Math.min(...changes.map((c) => Date.parse(c.at)));
  return oldest + UNREVIEWED_DAYS * 86_400_000 + PAST_WINDOW_MS;
}
