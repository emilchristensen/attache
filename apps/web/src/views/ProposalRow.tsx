import type { MemorySaveItem, ProposalCorrection, ProposalView } from "@attache/contracts";
import { Tag } from "../components/Tag.tsx";
import { Link } from "../components/ui.tsx";
import { proposalOutcome, proposalRowText } from "../approvals.ts";
import { ApprovalRow } from "./ApprovalRow.tsx";

/**
 * Every part of the change, so the owner sees exactly what Apply writes. A fact the note holds with another value is
 * a correction: the old value is shown struck through before the new one, since Apply moves it to History.
 */
function Parts({ item, corrections }: { item: MemorySaveItem; corrections: readonly ProposalCorrection[] }) {
  const correctionOf = (subject: string) => corrections.find((c) => c.subject.toLowerCase() === subject.toLowerCase());
  return (
    <ul className="proposal-parts">
      {(item.facts ?? []).map((f) => {
        const correction = correctionOf(f.subject);
        return (
          <li key={`fact:${f.subject}`} data-part={correction ? "correction" : "fact"}>
            <span className="part-kind">{correction ? "Correction" : "Fact"}</span>
            <span>
              <strong>{f.subject}</strong>:{" "}
              {correction && (
                <>
                  <del title={`Current value since ${correction.was.date}`}>{correction.was.value}</del>{" "}
                  <span aria-hidden className="muted">
                    →
                  </span>{" "}
                </>
              )}
              {f.value}
              {f.review && <span className="muted"> · review after {f.review}</span>}
              {"reason" in f && typeof f.reason === "string" && <span className="muted"> ({f.reason})</span>}
            </span>
          </li>
        );
      })}
      {(item.events ?? []).map((e, i) => (
        <li key={`event:${i}`} data-part="event">
          <span className="part-kind">Event</span>
          <span>{e}</span>
        </li>
      ))}
      {item.action === "create" && item.notes?.trim() && (
        <li data-part="notes">
          <span className="part-kind">Notes</span>
          <span>{item.notes.trim()}</span>
        </li>
      )}
      {item.action === "create" && !!item.tags?.length && (
        <li data-part="tags">
          <span className="part-kind">Tags</span>
          <span>{item.tags.join(", ")}</span>
        </li>
      )}
    </ul>
  );
}

const FOLDER_TAB: Readonly<Record<string, string>> = { people: "person", projects: "project", decisions: "decision", notes: "note" };

/** Where a note lives in the Brain, for "Open in Brain": its path, with its collection's tab selected. */
export function brainNoteHref(relPath: string): string {
  const tab = FOLDER_TAB[relPath.split("/")[1] ?? ""];
  return `/brain?root=data&path=${encodeURIComponent(relPath)}${tab ? `&tab=${tab}` : ""}`;
}

/** The whole Proposal: every part, the reason, the evidence and where it came from. */
function ProposalDetail({ p }: { p: ProposalView }) {
  return (
    <>
      {p.item ? <Parts item={p.item} corrections={p.corrections} /> : <p>This Proposal can no longer be read. Reject it to clear it.</p>}
      {p.reason && (
        <p className="proposal-why" data-why>
          <span className="part-kind">Why</span>
          <span>{p.reason}</span>
        </p>
      )}
      {p.evidence && (
        <figure className="proposal-evidence" data-evidence>
          <figcaption>Evidence</figcaption>
          <blockquote>{p.evidence}</blockquote>
        </figure>
      )}
      <p className="approval-provenance">
        {p.source && <>Source: {p.source} · </>}
        Proposed by {p.proposedBy} on {p.proposedOn}
        {p.decidedOn && p.status !== "proposed" && (
          <>
            {" "}
            · {proposalOutcome(p.status)} on {p.decidedOn}
          </>
        )}
      </p>
    </>
  );
}

export interface ProposalDecide {
  apply: (p: ProposalView) => void;
  reject: (p: ProposalView) => void;
  busy: boolean;
  /** Why the service refused to apply it, while that stands: Apply stays off, Reject stays available. */
  refusal: string | null;
}

/**
 * A Proposal's row: the note it changes, then the change, previous to new ("Owner: Sam → Nora") or what it adds.
 * Waiting, it opens in place with every part, its reason and evidence, then Apply and Reject; finished, with its
 * outcome instead of the decisions.
 */
export function ProposalRow({ p, open, onToggle, decide }: { p: ProposalView; open: boolean; onToggle: () => void; decide: ProposalDecide | null }) {
  const text = proposalRowText(p);
  const finished = p.status !== "proposed";
  return (
    <ApprovalRow
      kind="proposal"
      id={p.id}
      subject={text.note}
      at={p.decidedAt ?? p.createdAt}
      open={open}
      onToggle={onToggle}
      meta={
        <>
          {finished && <Tag tone={p.status === "rejected" ? "outline" : "neutral"}>{proposalOutcome(p.status)}</Tag>}
          {text.added && <Tag hue="plum">{text.added}</Tag>}
          <span className="approval-preview">{text.change}</span>
        </>
      }
      detail={
        <>
          <ProposalDetail p={p} />
          {decide?.refusal && (
            <p className="approval-refusal" role="alert">
              <strong>Not applied.</strong> {decide.refusal}
            </p>
          )}
          <div className="approval-actions">
            {decide && (
              <>
                <button className="primary" disabled={decide.busy || !p.item || decide.refusal !== null} onClick={() => decide.apply(p)}>
                  Apply
                </button>
                <button disabled={decide.busy} onClick={() => decide.reject(p)}>
                  Reject
                </button>
              </>
            )}
            {p.status === "applied" && (
              <Link to={brainNoteHref(p.target)} className="btn">
                Open in Brain
              </Link>
            )}
          </div>
        </>
      }
    />
  );
}
