import { post } from "../api.ts";
import { useAction } from "../components/ui.tsx";

/** What the owner reads once a rebuild has started: it runs as a job, so it says where to follow it. */
export const REBUILD_STARTED = "Rebuilding the search index. Jobs shows its progress.";

/** Rebuild index: reads every note again into the search index, as a job. Shared by the Brain's menu and Settings. */
export function useRebuildIndex(): { rebuild: () => void; busy: boolean } {
  const { busy, run } = useAction();
  return { rebuild: () => void run("reindex", () => post("/memory/reindex"), REBUILD_STARTED), busy: busy !== null };
}

/** Settings' place for Rebuild index, beside meaning-based search. */
export function SearchIndexCard() {
  const { rebuild, busy } = useRebuildIndex();
  return (
    <div className="card stack-sm" data-search-index>
      <h3>Search index</h3>
      <p className="small muted">Search reads the index, not the files. Rebuild it when search misses a note you know is there: Attache reads every note again. Notes are not changed.</p>
      <div>
        <button disabled={busy} onClick={rebuild}>
          Rebuild index
        </button>
      </div>
    </div>
  );
}
