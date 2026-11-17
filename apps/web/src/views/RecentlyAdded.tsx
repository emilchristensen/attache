import { useEffect } from "react";
import { UNREVIEWED_DAYS, type RecentChangeView, type RecentChangesResult } from "@attache/contracts";
import { useResource } from "../live.ts";
import { ChangeRow } from "../components/RecentChange.tsx";
import { useCollapsedList } from "../components/collapsed-list.tsx";
import { ErrorState, Loading } from "../components/ui.tsx";

/**
 * Every change written to the Brain without the owner reviewing it in the last
 * 7 days (ADR 0004): auto-accepted saves and Consolidation's changes, newest
 * first, each with its source and a one-click revert. Older ones drop off on
 * their own, so there is nothing to mark as seen.
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
  return (
    <section className="recently-added" aria-labelledby="recently-added-title">
      <div className="section-title" id="recently-added-title">
        Recently added
        {changes.length > 0 && <span className="muted">{changes.length}</span>}
        {toggle}
      </div>
      {res.loading && !res.data && <Loading lines={2} />}
      <ErrorState error={res.error} retry={res.reload} title="Recently added could not load" />
      {res.data && changes.length === 0 && <p className="small muted">Nothing was written without your review in the last 7 days.</p>}
      {changes.length > 0 && (
        <ul className="recent-changes card">
          {shown.map((c) => (
            <ChangeRow key={c.id} c={c} onReverted={res.reload} home />
          ))}
        </ul>
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
