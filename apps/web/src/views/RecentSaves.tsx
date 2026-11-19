import { useState } from "react";
import type { RecentChangesResult } from "@attache/contracts";
import { useResource } from "../live.ts";
import { ChangeRow } from "../components/RecentChange.tsx";
import { ErrorState, Loading, navigate } from "../components/ui.tsx";
import { ChipNav } from "../components/ChipNav.tsx";
import { brainHref, filterChanges, RECENT_FILTERS, type RecentFilter } from "../brain.ts";

/** The most changes the service lists at once. */
const RECENT_LIMIT = 200;
/** Changes shown before "Show more". */
const RECENT_PAGE = 50;

const FILTER_LINKS = RECENT_FILTERS.map((f) => ({ id: f.id, label: f.label, href: brainHref({ view: "recent", show: f.id }) }));

const EMPTY: Record<RecentFilter, string> = {
  all: "Nothing has been saved to the Brain yet. Saves from a Harness, applied Proposals and reverts show here, newest first.",
  unreviewed: "Nothing reached the Brain without review. Auto-accepted saves and Consolidation's writes show here.",
  reverted: "Nothing has been reverted.",
};

/**
 * Recent saves, the Brain's second view: every change to the Brain, newest first, with where it came from and
 * whether Revert can undo it, filtered to all, those written without review, or those reverted.
 */
export function RecentSaves({ show }: { show: RecentFilter }) {
  const res = useResource<RecentChangesResult>(`/memory/recent-changes?limit=${RECENT_LIMIT}`, ["memory.changed"]);
  const [pages, setPages] = useState(1);
  const changes = filterChanges(res.data?.changes ?? [], show);
  const shown = changes.slice(0, pages * RECENT_PAGE);
  const choose = (filter: RecentFilter) => {
    setPages(1);
    navigate(brainHref({ view: "recent", show: filter }), { replace: true });
  };
  return (
    <section className="recent-saves" aria-labelledby="recent-saves-title">
      <h2 id="recent-saves-title" className="sr-only">
        Recent saves
      </h2>
      <ChipNav label="Show" className="chips recent-filters" items={FILTER_LINKS} current={show} onChoose={choose} />
      <div className="recent-list">
        {res.loading && !res.data && <Loading lines={4} label="Loading recent saves" />}
        <ErrorState error={res.error} retry={res.reload} title="Recent saves could not load" />
        {res.data && !changes.length && <p className="recent-empty">{EMPTY[show]}</p>}
        {shown.length > 0 && (
          <ul className="recent-changes">
            {shown.map((c) => (
              <ChangeRow key={c.id} c={c} onReverted={res.reload} />
            ))}
          </ul>
        )}
        {changes.length > shown.length && (
          <button className="ghost small recent-more" onClick={() => setPages(pages + 1)}>
            Show {Math.min(RECENT_PAGE, changes.length - shown.length)} more
          </button>
        )}
      </div>
    </section>
  );
}
