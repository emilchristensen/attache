import type { RecentChangesResult } from "@attache/contracts";
import { useResource } from "../live.ts";
import { ChangeRow } from "../components/RecentChange.tsx";
import { useCollapsedList } from "../components/collapsed-list.tsx";
import { ErrorState } from "../components/ui.tsx";

/** The newest changes to the Brain, where each came from, and one-click revert. */
export function RecentSaves() {
  const res = useResource<RecentChangesResult>("/memory/recent-changes?limit=50", ["memory.changed"]);
  const changes = res.data?.changes ?? [];
  const { shown, toggle } = useCollapsedList(changes);
  if (res.error) return <ErrorState error={res.error} retry={res.reload} title="Recent saves could not load" />;
  if (!changes.length) return null;
  return (
    <section className="card recent-saves" aria-labelledby="recent-saves-title">
      <div className="row">
        <h3 id="recent-saves-title" style={{ flex: 1 }}>
          Recent saves
        </h3>
        {toggle}
      </div>
      <ul className="recent-changes">
        {shown.map((c) => (
          <ChangeRow key={c.id} c={c} onReverted={res.reload} />
        ))}
      </ul>
    </section>
  );
}
