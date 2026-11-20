import { useEffect, useMemo, useState } from "react";
import { plural, type ConnectionDefinition, type ConnectionStatus, type DisconnectEffects, type FeatureStatus, type ReaderView } from "@attache/contracts";
import { api, post } from "../api.ts";
import { useResource, type Resource } from "../live.ts";
import { Link, navigate, useAction } from "../components/ui.tsx";
import { Icon } from "../components/icons.tsx";
import { connectionBanner, connectionsStatus, type ConnectionsStatus, type Reply, type StatusAction } from "../connection-status.ts";
import { connectionHref, reconfigureSignIn, reconnectMethod, retestConnection, startBrowserSignIn, testSignIn } from "../reconnect.ts";
import { useReader } from "./ReaderLine.tsx";
import { settingsHref } from "../routes.ts";
import { DisconnectConfirm } from "../components/ConnectionParts.tsx";

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

/** The highest-priority Connection issue under the masthead, once per issue change. */
export function ConnectionBanner({ view }: { view: ConnectionsView }) {
  const banner = connectionBanner(view.status);
  const [preview, setPreview] = useState<{ status: ConnectionStatus; effects: DisconnectEffects } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  if (!banner) return null;
  const { issue } = banner;
  const lineId = `connection-banner-${issue.key}`;
  const connection = banner.disableConnectionId ? view.caps?.connections.find((c) => c.id === banner.disableConnectionId) : undefined;
  const disable = () => {
    if (!banner.disableConnectionId) return;
    void api<DisconnectEffects>(`/connections/${encodeURIComponent(banner.disableConnectionId)}/disconnect-preview`).then((effects) => {
      const status = view.caps?.connections.find((c) => c.id === banner.disableConnectionId);
      if (status) setPreview({ status, effects });
    });
  };
  const announcement = `${issue.subject} · ${issue.word} · ${issue.impact}`;
  return (
    <section className={`connection-banner banner ${issue.hue === "red" ? "danger" : "warn"}`} aria-label="Connection issue" data-connection-banner data-state={issue.state}>
      <Icon name={issue.icon} />
      <div className="connection-banner-copy">
        <span id={lineId} className="connection-banner-line">
          <strong>{issue.subject}</strong> · <strong>{issue.word}</strong> · <span>{issue.impact}</span>
        </span>
      </div>
      <div className="connection-banner-primary">{banner.fix && <RowAction action={banner.fix} describedBy={lineId} view={view} />}</div>
      {banner.more > 0 && <Link to="/connections" className="connection-banner-more">{plural(banner.more, "more connection issue")}</Link>}
      <div className="connection-banner-secondary">
        {connection && <button className="ghost danger small" onClick={disable}>Disable</button>}
        <Link to="/connections" className="btn ghost small">Go to Connections</Link>
      </div>
      <div className="connection-banner-menu">
        <button className="ghost" aria-expanded={menuOpen} aria-label="Connection issue actions" onClick={() => setMenuOpen(!menuOpen)}>Actions</button>
        {menuOpen && (
          <div className="connection-banner-menu-popover">
            {connection && <button className="ghost danger" onClick={disable}>Disable</button>}
            <Link to="/connections" className="btn ghost">Go to Connections</Link>
          </div>
        )}
      </div>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
      {preview && (
        <DisconnectConfirm
          status={preview.status}
          preview={preview.effects}
          disconnect={(deleteData) => {
            void post(`/connections/${preview.status.id}/disconnect`, { deleteData }).then(() => {
              setPreview(null);
              view.reload();
            });
          }}
          onCancel={() => setPreview(null)}
        />
      )}
    </section>
  );
}
