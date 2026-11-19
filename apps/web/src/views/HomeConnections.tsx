import { useEffect, useId, useMemo, useState } from "react";
import { plural, type ConnectionDefinition, type ConnectionStatus, type FeatureStatus, type ReaderView } from "@attache/contracts";
import { post } from "../api.ts";
import { useResource, type Resource } from "../live.ts";
import { Link, navigate, Time, useAction } from "../components/ui.tsx";
import { Icon } from "../components/icons.tsx";
import { hueClass } from "../theme/hues.ts";
import { connectionsStatus, moreLabel, nameList, splitRows, type ConnectionsStatus, type Reply, type StatusAction, type StatusRow } from "../connection-status.ts";
import { connectionHref, reconfigureSignIn, reconnectMethod, retestConnection, startBrowserSignIn, testSignIn } from "../reconnect.ts";
import { clockTime } from "../zoned-time.ts";
import { useReader } from "./ReaderLine.tsx";
import { settingsHref } from "../routes.ts";

interface Caps {
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
  /** Ask all three again: Retry on "Could not check". */
  reload: () => void;
}

/** A resource as one answer: useResource keeps the last data after a failed refetch, and a failure still wins. */
function reply<T>(data: T | null, error: Resource<T>["error"]): Reply<T> {
  if (error) return { state: "failed", message: error.message };
  return data ? { state: "ok", data } : { state: "waiting" };
}

function mapReply<T, U>(r: Reply<T>, f: (t: T) => U): Reply<U> {
  return r.state === "ok" ? { state: "ok", data: f(r.data) } : r;
}

/** How often the schedule is asked again while its next run is due but not yet taken: the scheduler ticks this often. */
const OVERDUE_RECHECK_MS = 15_000;

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
    const timer = window.setTimeout(() => {
      setTick((n) => n + 1);
      reload();
    }, left > 0 ? left + 1000 : OVERDUE_RECHECK_MS);
    return () => window.clearTimeout(timer);
  }, [due, reload, tick]);
  return scheduled && due !== null && due > Date.now() ? scheduled : null;
}

/**
 * The three answers behind Home's Connections area, asked once and decided by `connectionsStatus`. Home passes the
 * result to the area and to the Inbox, which must not claim a complete list when this area shows a problem.
 */
export function useConnectionsStatus(): ConnectionsView {
  // Not on every job event: a finished Source refresh changes a Connection's coverage, which sends `connections.changed`.
  const caps = useResource<Caps>("/capabilities", ["connections.changed", "config.changed"]);
  const reader = useReader();
  const schedules = useResource<Schedule[]>("/schedules", ["config.changed", "reader.changed"]);
  const nextRefreshAt = useNextRefresh(schedules);
  const { data: capsData, error: capsError } = caps;
  const { data: readerData, error: readerError } = reader;
  const status = useMemo(() => {
    const capsReply = reply(capsData, capsError);
    return connectionsStatus({ connections: mapReply(capsReply, (c) => c.connections), features: mapReply(capsReply, (c) => c.features), reader: reply<ReaderView>(readerData, readerError), nextRefreshAt });
  }, [capsData, capsError, readerData, readerError, nextRefreshAt]);
  return {
    status,
    caps: caps.data,
    reload: () => {
      caps.reload();
      reader.reload();
      schedules.reload();
    },
  };
}

/** "this Machine" inside a sentence, another Machine by its name. */
function readerInSentence(reader: string): string {
  return reader === "This Machine" ? "this Machine" : reader;
}

function AllGood({ status }: { status: Extract<ConnectionsStatus, { kind: "all_good" }> }) {
  return (
    <div className={`conn-good ${hueClass("green")}`}>
      <Icon name="check" size={18} />
      <h2 id="home-connections-title" className="conn-title">
        Connections
      </h2>
      <span className="conn-good-word">All good</span>
      <span className="conn-good-meta">
        {plural(status.sources, "source")} read
        {status.lastReadAt && (
          <>
            {" "}
            <Time iso={status.lastReadAt} /> by {readerInSentence(status.reader)}
          </>
        )}
        {status.others > 0 && <> · {status.others === 1 ? "1 other Connection works" : `${status.others} other Connections work`}</>}
      </span>
      <Link to="/connections" className="conn-details">
        View details
      </Link>
    </div>
  );
}

function LastRead({ lastRead }: { lastRead: StatusRow["lastRead"] }) {
  if (!lastRead.length) return null;
  if (lastRead.length === 1) {
    const at = lastRead[0]!.at;
    return <p>{at ? <>Last read <Time iso={at} />.</> : "Never read."}</p>;
  }
  return (
    <p>
      Last read:{" "}
      {lastRead.map((r, n) => (
        <span key={r.name}>
          {n > 0 && ", "}
          {r.name} {r.at ? <Time iso={r.at} /> : "never"}
        </span>
      ))}
      .
    </p>
  );
}

function Retry({ retry }: { retry: StatusRow["retry"] }) {
  if (!retry) return null;
  if (retry.kind === "none") return <p>Nothing is read again by itself.</p>;
  return (
    <p>
      The next automatic read is at about <time dateTime={retry.at}>{clockTime(Date.parse(retry.at), Intl.DateTimeFormat().resolvedOptions().timeZone)}</time>.
    </p>
  );
}

function RowAction({ action, describedBy, view }: { action: StatusAction; describedBy: string; view: ConnectionsView }) {
  const { busy, run } = useAction();
  switch (action.kind) {
    case "reconnect": {
      const status = view.caps?.connections.find((c) => c.id === action.connectionId);
      const definition = view.caps?.definitions.find((d) => d.kind === status?.kind);
      const method = status && definition ? reconnectMethod(status, definition) : "credentials";
      const reconnect = () => {
        if (method === "credentials" || !status) return navigate(connectionHref(action.connectionId));
        if (method === "browser") return void run("reconnect", () => startBrowserSignIn(status.kind));
        void run("reconnect", () => (method === "reconfigure" ? reconfigureSignIn(status) : testSignIn(status.id)).then(view.reload), "Reconnected");
      };
      return (
        <button className="small primary" aria-describedby={describedBy} disabled={busy !== null} onClick={reconnect}>
          {busy ? "Reconnecting…" : "Reconnect"}
        </button>
      );
    }
    case "refresh":
      return (
        <button
          className="small"
          aria-describedby={describedBy}
          disabled={busy !== null}
          onClick={() => run("refresh", () => Promise.all(action.connectionIds.map((id) => post(`/connections/${encodeURIComponent(id)}/refresh`))), "Refresh started")}
        >
          {action.label}
        </button>
      );
    case "refresh_all":
      return (
        <button
          className="small"
          aria-describedby={describedBy}
          disabled={busy !== null}
          onClick={() => run("refresh", () => post("/jobs", { kind: "source-refresh", title: "Refresh every source", input: { all: true, reason: "manual" } }), "Refresh started")}
        >
          {action.label}
        </button>
      );
    case "test":
      return (
        <button className="small" aria-describedby={describedBy} disabled={busy !== null} onClick={() => run("test", () => retestConnection(action.connectionId).then(view.reload), "Working again")}>
          {action.label}
        </button>
      );
    case "retry_check":
      return (
        <button className="small" aria-describedby={describedBy} onClick={view.reload}>
          Retry
        </button>
      );
    case "open_connections":
      return (
        <Link to={connectionHref(action.connectionId)} className="btn small">
          Open in Connections
        </Link>
      );
    case "open_settings":
      return (
        <Link to={settingsHref("features")} className="btn small">
          Open Settings
        </Link>
      );
    case "machines":
      return (
        <Link to={settingsHref("machines")} className="btn small">
          Machines and Replication
        </Link>
      );
  }
}

/**
 * One problem: icon, subject, state word and what may be missing stay on the collapsed line beside the one button;
 * the sentence, what failed, the last read and any scheduled retry open in place.
 */
function ProblemRow({ row, view }: { row: StatusRow; view: ConnectionsView }) {
  const [open, setOpen] = useState(false);
  const lineId = useId();
  const detailId = useId();
  const expandable = row.state !== "checking";
  const line = (
    <>
      <Icon name={row.icon} size={18} className="conn-row-icon" />
      <span className="conn-row-text" id={lineId}>
        <span className="conn-subject">{row.subject}</span>
        <span className="conn-sep"> · </span>
        <span className="conn-word">{row.word}</span>
        {row.impact !== row.word && (
          <>
            <span className="conn-sep"> · </span>
            <span className="conn-impact">{row.impact}</span>
          </>
        )}
      </span>
    </>
  );
  return (
    <li className={`conn-row ${hueClass(row.hue)}`} data-state={row.state} data-subject={row.subject}>
      {expandable ? (
        <button type="button" className="conn-row-line" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen(!open)}>
          {line}
          <Icon name="chevron" size={16} className="conn-row-chevron" />
        </button>
      ) : (
        <div className="conn-row-line">{line}</div>
      )}
      {row.action && (
        <div className="conn-row-action">
          <RowAction action={row.action} describedBy={lineId} view={view} />
        </div>
      )}
      {expandable && (
        <div id={detailId} className="conn-row-detail" hidden={!open}>
          <p>{row.sentence}</p>
          {row.failure && <p className="conn-failure">{row.failure}</p>}
          {row.alsoAffected.length > 0 && <p>Also waiting on it: {nameList(row.alsoAffected)}.</p>}
          <LastRead lastRead={row.lastRead} />
          <Retry retry={row.retry} />
        </div>
      )}
    </li>
  );
}

function workingLine(working: { sources: number; others: number }): string | null {
  const parts = [working.sources && plural(working.sources, "other source"), working.others && plural(working.others, "other Connection")].filter(Boolean);
  if (!parts.length) return null;
  return `The ${parts.join(" and ")} ${working.sources + working.others === 1 ? "works" : "work"}.`;
}

function Problems({ status, view }: { status: Extract<ConnectionsStatus, { kind: "problems" }>; view: ConnectionsView }) {
  const { shown, more } = splitRows(status.rows);
  const working = status.working && workingLine(status.working);
  return (
    <>
      <div className="conn-head">
        <h2 id="home-connections-title" className="conn-title">
          Connections
        </h2>
        {working && <span className="conn-working">{working}</span>}
        <Link to="/connections" className="conn-details">
          View details
        </Link>
      </div>
      <ul className="conn-rows">
        {shown.map((r) => (
          <ProblemRow key={r.key} row={r} view={view} />
        ))}
      </ul>
      {more.length > 0 && (
        <details className="conn-more">
          <summary>
            <Icon name="chevron" size={16} className="conn-more-chevron" />
            {moreLabel(more)}
          </summary>
          <ul className="conn-rows">
            {more.map((r) => (
              <ProblemRow key={r.key} row={r} view={view} />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/**
 * Home's third area: one green line when every source was read and every Connection works, otherwise one row per
 * problem. A polite status region, so a change is announced once. Working Connections are never listed.
 */
export function HomeConnections({ view }: { view: ConnectionsView }) {
  const { status } = view;
  return (
    <section className="home-connections" role="status" aria-labelledby="home-connections-title" data-connections={status.kind}>
      {status.kind === "all_good" ? <AllGood status={status} /> : <Problems status={status} view={view} />}
    </section>
  );
}
