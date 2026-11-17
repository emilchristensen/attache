import { useState } from "react";
import type { RecentChangeView, RecentChangesResult } from "@attache/contracts";
import { post } from "../api.ts";
import { useResource } from "../live.ts";
import { ErrorState, Link, StatusPill, Time, useAction } from "../components/ui.tsx";

const COLLAPSED = 4;

function What({ c }: { c: RecentChangeView }) {
  switch (c.kind) {
    case "create":
      return <span>{c.revertOf ? "Brought the note back" : "Created the note"}</span>;
    case "delete":
      return <span>Removed the note</span>;
    case "append":
      return (
        <span>
          {c.subject === "Notes" ? "Edited the text: " : "Event: "}
          <span className="change-new">{c.newValue}</span>
        </span>
      );
    default:
      return (
        <span className="change-values">
          <strong>{c.subject}</strong>
          {c.oldValue !== null ? (
            <del className="change-old" title="Old value">
              {c.oldValue}
            </del>
          ) : (
            <span className="muted">(no value)</span>
          )}
          <span aria-hidden className="muted">
            →
          </span>
          {c.newValue !== null ? (
            <ins className="change-new" title="New value">
              {c.newValue}
            </ins>
          ) : (
            <span className="muted">(removed)</span>
          )}
          {c.newValue !== null && c.newReview && <span className="small muted">review after {c.newReview}</span>}
        </span>
      );
  }
}

function ChangeRow({ c, onReverted }: { c: RecentChangeView; onReverted: () => void }) {
  const { busy, run } = useAction();
  const gone = c.kind === "delete" || (c.kind === "create" && c.revertedBy !== null);
  return (
    <li className="recent-change" data-change={c.id}>
      <div className="recent-change-body">
        <div className="recent-change-head">
          {gone ? (
            <span className="recent-change-title">{c.title}</span>
          ) : (
            <Link to={`/memory?path=${encodeURIComponent(c.relPath)}`} className="recent-change-title" title={c.relPath}>
              {c.title}
            </Link>
          )}
          {c.revertOf && <StatusPill state="draft" label="revert" />}
          {c.source.autoAccepted && <span className="pill" title="Written without asking, because auto-accept was on for this Harness">auto-accepted</span>}
          {c.revertedBy && <StatusPill state="rejected" label="reverted" />}
        </div>
        <div className="recent-change-what">
          <What c={c} />
        </div>
        <div className="recent-change-meta separated">
          <span>{c.source.label}</span>
          <Time iso={c.at} />
        </div>
        {!c.revert.allowed && c.revertedBy === null && <p className="recent-change-why">{c.revert.reason}</p>}
      </div>
      {c.revert.allowed && (
        <button className="small" disabled={busy !== null} onClick={() => void run("revert", () => post(`/memory/changes/${c.id}/revert`).then(onReverted), "Reverted. The revert is listed as a change of its own.")}>
          Revert
        </button>
      )}
    </li>
  );
}

/** The newest changes to the Brain, where each came from, and one-click revert. */
export function RecentSaves() {
  const res = useResource<RecentChangesResult>("/memory/recent-changes?limit=50", ["memory.changed"]);
  const [expanded, setExpanded] = useState(false);
  const changes = res.data?.changes ?? [];
  if (res.error) return <ErrorState error={res.error} retry={res.reload} title="Recent saves could not load" />;
  if (!changes.length) return null;
  const shown = expanded ? changes : changes.slice(0, COLLAPSED);
  return (
    <section className="card recent-saves" aria-labelledby="recent-saves-title">
      <div className="row">
        <h3 id="recent-saves-title" style={{ flex: 1 }}>
          Recent saves
        </h3>
        {changes.length > COLLAPSED && (
          <button className="ghost small" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Show fewer" : `Show all ${changes.length}`}
          </button>
        )}
      </div>
      <ul className="recent-changes">
        {shown.map((c) => (
          <ChangeRow key={c.id} c={c} onReverted={res.reload} />
        ))}
      </ul>
    </section>
  );
}
