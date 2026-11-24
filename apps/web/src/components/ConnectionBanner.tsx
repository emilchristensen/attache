import { useState } from "react";
import { plural, type ConnectionStatus, type DisconnectEffects } from "@attache/contracts";
import { api, post } from "../api.ts";
import { connectionBanner, type StatusAction } from "../connection-status.ts";
import type { ConnectionsView } from "../connections-view.ts";
import { connectionHref, reconnectMethod, reconfigureSignIn, retestConnection, startBrowserSignIn, testSignIn } from "../reconnect.ts";
import { settingsHref } from "../routes.ts";
import { DisconnectConfirm } from "./ConnectionParts.tsx";
import { Icon } from "./icons.tsx";
import { usePopover } from "./menu.ts";
import { Link, navigate, useAction } from "./ui.tsx";

const CONNECTIONS = "/connections";

/** The state's fixing button: Reconnect, Retry (Refresh now while nothing was read yet), or Machines and Replication. */
function FixButton({ action, describedBy, view }: { action: StatusAction; describedBy: string; view: ConnectionsView }) {
  const { busy, run } = useAction();
  const caps = view.caps;
  switch (action.kind) {
    case "reconnect": {
      const status = caps?.connections.find((c) => c.id === action.connectionId);
      const definition = caps?.definitions.find((d) => d.kind === status?.kind);
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
        <button className="small" aria-describedby={describedBy} disabled={busy !== null} onClick={() => void run("refresh", () => Promise.all(action.connectionIds.map((id) => post(`/connections/${encodeURIComponent(id)}/refresh`))), "Refresh started")}>
          {action.label}
        </button>
      );
    case "refresh_all":
      return (
        <button className="small" aria-describedby={describedBy} disabled={busy !== null} onClick={() => void run("refresh", () => post("/jobs", { kind: "source-refresh", title: "Refresh every source", input: { all: true, reason: "manual" } }), "Refresh started")}>
          {action.label}
        </button>
      );
    case "test":
      return (
        <button className="small" aria-describedby={describedBy} disabled={busy !== null} onClick={() => void run("test", () => retestConnection(action.connectionId).then(view.reload), "Working again")}>
          {action.label}
        </button>
      );
    case "retry_check":
      return (
        <button className="small" aria-describedby={describedBy} onClick={view.reload}>
          Retry
        </button>
      );
    case "machines":
      return (
        <Link to={settingsHref("machines")} className="btn small">
          Machines and Replication
        </Link>
      );
    default:
      return null;
  }
}

/** Disable asks first: the service's preview of what disabling affects, then Disable or Cancel. */
function useDisable(view: ConnectionsView, connectionId: string | null) {
  const { busy, run } = useAction();
  const [preview, setPreview] = useState<{ status: ConnectionStatus; effects: DisconnectEffects } | null>(null);
  const status = connectionId ? (view.caps?.connections.find((c) => c.id === connectionId) ?? null) : null;
  const ask = () => {
    if (!status) return;
    void run("preview", async () => setPreview({ status, effects: await api<DisconnectEffects>(`/connections/${encodeURIComponent(status.id)}/disconnect-preview`) }));
  };
  const disable = (deleteData: boolean) => {
    if (!preview) return;
    void run(
      "disable",
      async () => {
        await post(`/connections/${encodeURIComponent(preview.status.id)}/disconnect`, { deleteData });
        setPreview(null);
        view.reload();
      },
      `${preview.status.label} is disabled`,
    );
  };
  return { status, preview, busy: busy !== null, ask, disable, cancel: () => setPreview(null) };
}

/**
 * The polite announcement of the banner's issue, mounted by the shell from the start and always there, so a screen
 * reader hears each new issue: only its words change, and only when the issue does, never on a refresh that leaves it
 * the same. Empty while no banner shows (`shown` false on the Connections page).
 */
export function ConnectionAnnouncement({ view, shown }: { view: ConnectionsView; shown: boolean }) {
  const banner = shown ? connectionBanner(view.status) : null;
  return (
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true" data-banner-announcement>
      {banner ? `${banner.issue.subject} · ${banner.issue.word} · ${banner.issue.impact}` : ""}
    </p>
  );
}

/**
 * The Connection banner under the masthead, on every screen but Connections: the issue that most needs the owner,
 * "N more connection issues", its fixing button, Disable when it belongs to one Connection, and Go to Connections. No
 * close button: it stays while the Inbox may be incomplete. The shell announces it (`ConnectionAnnouncement`).
 */
export function ConnectionBanner({ view }: { view: ConnectionsView }) {
  const banner = connectionBanner(view.status);
  const disable = useDisable(view, banner?.disableConnectionId ?? null);
  const menu = usePopover();
  if (!banner) return null;
  const { issue } = banner;
  const lineId = `connection-banner-${issue.key}`;
  const disableButton = disable.status && (
    <button className="ghost danger small" disabled={disable.busy} onClick={disable.ask}>
      Disable
    </button>
  );
  return (
    <section className={`connection-banner banner ${issue.hue === "red" ? "danger" : "warn"}`} aria-label="Connection issue" data-connection-banner data-state={issue.state}>
      <Icon name={issue.icon} />
      <div className="connection-banner-copy">
        <span id={lineId} className="connection-banner-line">
          <strong>{issue.subject}</strong> · <strong>{issue.word}</strong> · <span>{issue.impact}</span>
        </span>
      </div>
      <div className="connection-banner-primary">{banner.fix && <FixButton action={banner.fix} describedBy={lineId} view={view} />}</div>
      {banner.more > 0 && (
        <Link to={CONNECTIONS} className="connection-banner-more">
          {plural(banner.more, "more connection issue")}
        </Link>
      )}
      <div className="connection-banner-secondary">
        {disableButton}
        <Link to={CONNECTIONS} className="btn ghost small">
          Go to Connections
        </Link>
      </div>
      <div className="connection-banner-menu">
        <button className="ghost" aria-label="Connection issue actions" {...menu.buttonProps}>
          Actions
        </button>
        {menu.open && (
          <div className="connection-banner-menu-popover" aria-label="Connection issue actions" {...menu.listProps}>
            {disableButton}
            <Link to={CONNECTIONS} className="btn ghost">
              Go to Connections
            </Link>
          </div>
        )}
      </div>
      {disable.preview && <DisconnectConfirm status={disable.preview.status} preview={disable.preview.effects} disconnect={disable.disable} onCancel={disable.cancel} />}
    </section>
  );
}
