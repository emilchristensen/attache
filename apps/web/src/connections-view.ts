import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ConnectionDefinition, ConnectionStatus, FeatureStatus, ReaderView } from "@attache/contracts";
import { useResource, type Resource } from "./live.ts";
import { connectionsStatus, type ConnectionsStatus, type Reply } from "./connection-status.ts";
import { useReader } from "./views/ReaderLine.tsx";

/**
 * The Connections status the shell asks for once and shares (`ConnectionsContext`): the Connection banner and the
 * masthead's dot show it, and an empty Inbox claims no more than it establishes.
 */

export interface Caps {
  features: FeatureStatus[];
  connections: ConnectionStatus[];
  definitions: ConnectionDefinition[];
}

/** One of this Machine's schedules, as `GET /schedules` lists it. */
interface Schedule {
  jobKind: string;
  enabled: boolean;
  nextRunAt: string | null;
}

export interface ConnectionsView {
  status: ConnectionsStatus;
  caps: Caps | null;
  /** Ask all three again: Retry on "Could not check", and after a change such as Disable. */
  reload: () => void;
}

/** How soon a failed check is asked again on its own, while the failure may still be only a moment's. */
export const CHECK_RETRY_MS = 2_000;
/** A failed check counts only once it has lasted this long: a failure that lasts a moment never raises the banner. */
export const CHECK_GRACE_MS = 5_000;
/** How often a failure that has lasted is asked again on its own, so the banner goes once an answer comes. */
export const CHECK_RECHECK_MS = 10_000;

/**
 * A resource as one answer: useResource keeps the last data after a failed refetch, and a failure that has lasted
 * (`counted`) wins. Before then the last answer stands, or Checking when there is none yet.
 */
function reply<T>(data: T | null, error: Resource<T>["error"], counted = true): Reply<T> {
  if (error && counted) return { state: "failed", message: error.message };
  return data ? { state: "ok", data } : { state: "waiting" };
}

/**
 * A check's answer as the shell decides on it: a failure counts only once it has lasted `CHECK_GRACE_MS`, and a failed
 * check is asked again on its own (soon, then every `CHECK_RECHECK_MS`) rather than waiting for the next live event.
 */
function useSteadyReply<T>(resource: Pick<Resource<T>, "data" | "error" | "reload">): Reply<T> {
  const { data, error, reload } = resource;
  const failing = error !== null;
  const [lasted, setLasted] = useState(false);
  useEffect(() => {
    setLasted(false);
    if (!failing) return;
    const timer = window.setTimeout(() => setLasted(true), CHECK_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [failing]);
  // Armed again by each new failure, so a check that keeps failing keeps being asked.
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(reload, lasted ? CHECK_RECHECK_MS : CHECK_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [error, lasted, reload]);
  return useMemo(() => reply(data, error, lasted), [data, error, lasted]);
}

function mapReply<T, U>(r: Reply<T>, f: (t: T) => U): Reply<U> {
  return r.state === "ok" ? { state: "ok", data: f(r.data) } : r;
}

/** How often the schedule is asked again while its next run is due but not yet taken: the scheduler ticks this often. */
const OVERDUE_RECHECK_MS = 15_000;
/** How long after its due time a scheduled run is asked about, so the answer names the run that just started. */
const AFTER_DUE_MS = 1000;

/**
 * When this Machine's Source refresh runs next, promised only while that time is ahead and the schedule answered. At
 * the due time the promise goes and the schedule is asked again, every 15 seconds until it names a later time, since
 * a scheduled refresh that runs long may send no event that would.
 */
function useNextRefresh(schedules: Resource<Schedule[]>): string | null {
  // Bumped when a timer fires, so the hook runs again and reads the clock afresh.
  const [tick, setTick] = useState(0);
  const scheduled = schedules.error ? null : (schedules.data?.find((s) => s.jobKind === "source-refresh" && s.enabled)?.nextRunAt ?? null);
  const due = scheduled ? Date.parse(scheduled) : null;
  const { reload } = schedules;
  useEffect(() => {
    if (due === null) return;
    // The clock is read when the timer is armed, so a schedule that changes on an open page is timed from now.
    const left = due - Date.now();
    const timer = window.setTimeout(
      () => {
        setTick((n) => n + 1);
        reload();
      },
      left > 0 ? left + AFTER_DUE_MS : OVERDUE_RECHECK_MS,
    );
    return () => window.clearTimeout(timer);
  }, [due, reload, tick]);
  return scheduled && due !== null && due > Date.now() ? scheduled : null;
}

/** The three answers behind the Connections status, asked once by the shell and decided by `connectionsStatus`. */
export function useConnectionsStatus(): ConnectionsView {
  // Not on every job event: a finished Source refresh changes a Connection's coverage, which sends `connections.changed`.
  const caps = useResource<Caps>("/capabilities", ["connections.changed", "config.changed"]);
  const reader = useReader();
  const schedules = useResource<Schedule[]>("/schedules", ["config.changed", "reader.changed"]);
  const nextRefreshAt = useNextRefresh(schedules);
  const capsReply = useSteadyReply(caps);
  const readerReply = useSteadyReply<ReaderView>(reader);
  const { data: capsData, reload: reloadCaps } = caps;
  const reloadReader = reader.reload;
  const reloadSchedules = schedules.reload;
  return useMemo(() => {
    const status = connectionsStatus({ connections: mapReply(capsReply, (c) => c.connections), features: mapReply(capsReply, (c) => c.features), reader: readerReply, nextRefreshAt });
    const reload = () => {
      reloadCaps();
      reloadReader();
      reloadSchedules();
    };
    return { status, caps: capsData, reload };
  }, [capsReply, readerReply, capsData, nextRefreshAt, reloadCaps, reloadReader, reloadSchedules]);
}

/** Checking, until the shell's answers arrive: never a claim that every Connection works. */
const CHECKING: ConnectionsView = {
  status: connectionsStatus({ connections: { state: "waiting" }, features: { state: "waiting" }, reader: { state: "waiting" }, nextRefreshAt: null }),
  caps: null,
  reload: () => undefined,
};

export const ConnectionsContext = createContext<ConnectionsView>(CHECKING);

/** The shell's Connections status, for any screen. */
export function useConnections(): ConnectionsView {
  return useContext(ConnectionsContext);
}
