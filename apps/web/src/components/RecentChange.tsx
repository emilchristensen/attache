import type { RecentChangeView } from "@attache/contracts";
import { post } from "../api.ts";
import { Link, Time, useAction } from "./ui.tsx";
import { StateTag } from "./StateTag.tsx";
import { Tag } from "./Tag.tsx";

/** What one change did to its note: a note created or removed, an event, or a fact's old value and new value. */
export function What({ c }: { c: RecentChangeView }) {
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

/**
 * How a change reached the Brain without review: Consolidation, or a save
 * auto-accept let through. On Home every change is unreviewed, so only
 * Consolidation's are marked there.
 */
function UnreviewedTag({ c, home }: { c: RecentChangeView; home: boolean }) {
  if (!c.source.autoAccepted || (home && !c.source.consolidation)) return null;
  return c.source.consolidation ? (
    <Tag title="Written without asking, because Consolidation found it in a finished session or meeting">
      consolidated
    </Tag>
  ) : (
    <Tag title="Written without asking, because auto-accept was on for this Harness">
      auto-accepted
    </Tag>
  );
}

/**
 * One change with its note, what changed, where it came from and when, and a
 * one-click revert. On Home (`home`) it also says why a fact was corrected.
 */
export function ChangeRow({ c, onReverted, home = false }: { c: RecentChangeView; onReverted: () => void; home?: boolean }) {
  const { busy, run } = useAction();
  const gone = c.kind === "delete" || (c.kind === "create" && c.revertedBy !== null);
  return (
    <li className="recent-change" data-change={c.id}>
      <div className="recent-change-body">
        <div className="recent-change-head">
          {gone ? (
            <span className="recent-change-title">{c.title}</span>
          ) : (
            <Link to={`/brain?path=${encodeURIComponent(c.relPath)}`} className="recent-change-title" title={c.relPath}>
              {c.title}
            </Link>
          )}
          {c.revertOf && <StateTag state="draft" label="revert" />}
          <UnreviewedTag c={c} home={home} />
          {c.revertedBy && <StateTag state="rejected" label="reverted" />}
        </div>
        <div className="recent-change-what">
          <What c={c} />
          {home && c.kind === "correct" && c.reason && <span className="muted"> ({c.reason})</span>}
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
