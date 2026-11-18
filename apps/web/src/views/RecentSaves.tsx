import type { RecentChangesResult } from "@attache/contracts";
import { useResource } from "../live.ts";
import { ChangeRow } from "../components/RecentChange.tsx";
import { useCollapsedList } from "../components/collapsed-list.tsx";
import { ErrorState } from "../components/ui.tsx";

/**
 * The newest changes to the Brain, where each came from, and one-click revert. With none it shows nothing, unless
 * the owner came here for it (`/brain/recent`, Home's Browse), when it says so.
 */
export function RecentSaves({ here = false }: { here?: boolean }) {
  const res = useResource<RecentChangesResult>("/memory/recent-changes?limit=50", ["memory.changed"]);
  const changes = res.data?.changes ?? [];
  const { shown, toggle } = useCollapsedList(changes);
  if (res.error) return <ErrorState error={res.error} retry={res.reload} title="Recent saves could not load" />;
  if (!changes.length)
    return here && res.data ? (
      <section className="card recent-saves" aria-labelledby="recent-saves-title">
        <h3 id="recent-saves-title">Recent saves</h3>
        <p className="small muted">Nothing has been saved to the Brain yet. Saves from a Harness show here, newest first.</p>
      </section>
    ) : null;
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
