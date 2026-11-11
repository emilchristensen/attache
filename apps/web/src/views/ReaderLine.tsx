import type { ReaderView } from "@jarvis/contracts";
import { useResource } from "../live.ts";
import { Time } from "../components/ui.tsx";

export const READER_EVENTS = ["reader.changed", "replication.changed", "config.changed"];

/** Which Machine the Reader is, in the owner's words. */
function readerName(r: ReaderView): string {
  if (!r.machine) return "No Machine";
  return r.thisMachine ? "This Machine" : r.machine.name;
}

function LastRefresh({ at }: { at: string | null }) {
  return at ? (
    <>
      Last Source refresh <Time iso={at} />.
    </>
  ) : (
    <>No Source refresh has run yet.</>
  );
}

/**
 * Who runs scheduled Source refresh and briefings, and when every source was
 * last refreshed, so the owner knows how fresh the inbox is on any Machine.
 */
export function ReaderLine() {
  const reader = useResource<ReaderView>("/reader", READER_EVENTS);
  const r = reader.data;
  if (!r) return null;
  const state = !r.replicated ? "alone" : !r.machine ? "none" : r.silent ? "silent" : r.thisMachine ? "this" : "other";
  return (
    <p className={`reader-line small${r.silent ? " silent" : ""}`} data-reader={state} data-reader-name={r.machine?.name ?? ""} role="status">
      {state === "none" ? (
        <>No Machine is the Reader yet; this Machine learns which one at its next check of the repository. </>
      ) : state === "silent" ? (
        <>
          {readerName(r)} was the Reader but has been silent since <Time iso={r.heartbeatAt} />, so no Machine reads the sources on a schedule.{" "}
        </>
      ) : (
        <>{readerName(r)} runs Source refresh and briefings. </>
      )}
      <LastRefresh at={r.lastRefreshAt} />
    </p>
  );
}
