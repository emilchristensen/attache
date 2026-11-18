import { useEffect } from "react";
import { READER_SILENT_AFTER_MS, type ReaderView } from "@attache/contracts";
import { useResource } from "../live.ts";
import { Link, Time } from "../components/ui.tsx";
import { Icon } from "../components/icons.tsx";

export const READER_EVENTS = ["reader.changed", "replication.changed", "config.changed"];

/** How often to ask again after a failed answer, or while the lease looks lapsed but no answer says so yet (clocks apart). */
const RECHECK_MS = 30_000;

/**
 * The Reader as the service sees it now. The service decides `silent` when asked, and a lease that simply runs out
 * sends no event, so this asks again just after the current lease would lapse. A failed answer is asked again too, so
 * neither a missing warning nor a stale one waits for the next event.
 */
function useReader() {
  const reader = useResource<ReaderView>("/reader", READER_EVENTS);
  const { data, error, loading, reload } = reader;
  useEffect(() => {
    if (loading) return;
    const lapses = !error && data?.heartbeatAt && !data.silent ? Date.parse(data.heartbeatAt) + READER_SILENT_AFTER_MS - Date.now() : null;
    if (!error && lapses === null) return;
    const timer = window.setTimeout(reload, lapses !== null && lapses > 0 ? lapses + 1000 : RECHECK_MS);
    return () => window.clearTimeout(timer);
  }, [data, error, loading, reload]);
  return reader;
}

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
  const reader = useReader();
  const r = reader.data;
  if (!r) return null;
  const state = !r.replicated ? "alone" : !r.machine ? "none" : r.silent ? "silent" : r.thisMachine ? "this" : "other";
  return (
    <p className={`reader-line small${r.silent ? " silent" : ""}`} data-reader={state} data-reader-name={r.machine?.name ?? ""} role="status">
      {state === "none" ? (
        <>No Machine is the Reader yet; this Machine learns which one at its next check of the repository. </>
      ) : state === "silent" ? (
        <>
          {readerName(r)} was the Reader but went silent <Time iso={r.heartbeatAt} />, so no Machine reads the sources on a schedule.{" "}
        </>
      ) : (
        <>{readerName(r)} runs Source refresh and briefings. </>
      )}
      <LastRefresh at={r.lastRefreshAt} />
    </p>
  );
}

/**
 * The persistent warning under the masthead while the Reader is silent: nothing reads the sources on a
 * schedule, so it stays in view on every screen and size until a Reader renews its lease.
 */
export function ReaderWarning() {
  const r = useReader().data;
  if (!r?.silent) return null;
  return (
    <div className="banner danger" role="status" data-reader-warning>
      <Icon name="warning" />
      <p>
        <strong>Not reading.</strong> {readerName(r)} was the Reader but went silent <Time iso={r.heartbeatAt} />, so no Machine reads the sources on a schedule. <Link to="/settings">Machines and Replication</Link>
      </p>
    </div>
  );
}
