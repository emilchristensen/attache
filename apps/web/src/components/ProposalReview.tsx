import type { MemorySaveItem, ProposalCorrection, ProposalView } from "@attache/contracts";
import { post } from "../api.ts";
import { useResource } from "../live.ts";
import { Empty, ErrorState, Loading, Time, useAction } from "./ui.tsx";

function headline(item: MemorySaveItem | null, target: string): string {
  if (!item) return `Unreadable change to ${target}`;
  return item.action === "create" ? `New ${item.type}: ${item.title}` : `Update ${target}`;
}

/**
 * Every part of the change, so the owner sees exactly what Apply writes. A fact
 * the note holds with another value is a correction: the old value is shown
 * struck through before the new one, since Apply moves it to History.
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

/** Pending Proposals, the changes to the Brain that wait under Approvals, each shown whole and decided with one click. */
export function ProposalReview() {
  const q = useResource<{ proposals: ProposalView[] }>("/memory/proposals?status=proposed", ["memory.changed"]);
  const { busy, run } = useAction();
  const proposals = q.data?.proposals ?? [];
  const decide = (p: ProposalView, decision: "apply" | "reject") => run(`${decision}:${p.id}`, () => post(`/memory/proposals/${p.id}/${decision}`).then(q.reload), decision === "apply" ? "Applied" : "Rejected");
  return (
    <section className="approvals-section stack-sm" aria-labelledby="proposal-review-heading">
      <h2 id="proposal-review-heading">Changes to the Brain{proposals.length ? ` (${proposals.length})` : ""}</h2>
      {q.loading && !q.data && <Loading lines={2} />}
      <ErrorState error={q.error} retry={q.reload} />
      {q.data && !proposals.length && <Empty title="No changes to review">A Proposal from a Harness or Consolidation appears here to apply or reject.</Empty>}
      {proposals.length > 0 && (
        <div className="card stack-sm">
          {proposals.map((p) => (
            <article key={p.id} className="item" data-proposal={p.id} aria-label={headline(p.item, p.target)}>
              <div className="title">{headline(p.item, p.target)}</div>
              {p.item ? <Parts item={p.item} corrections={p.corrections} /> : <div className="summary">This Proposal can no longer be read. Reject it to clear it.</div>}
              {p.evidence && (
                <figure className="proposal-evidence" data-evidence>
                  <figcaption>Evidence</figcaption>
                  <blockquote>{p.evidence}</blockquote>
                </figure>
              )}
              <div className="meta proposal-meta separated">
                {p.reason && <span>Why: {p.reason}</span>}
                {p.source && <span>Source: {p.source}</span>}
                <span>
                  Proposed by {p.proposedBy} on {p.proposedOn} <Time iso={p.createdAt} />
                </span>
              </div>
              <div className="item-actions">
                <button className="small primary" disabled={busy !== null || !p.item} onClick={() => void decide(p, "apply")}>
                  Apply
                </button>
                <button className="small" disabled={busy !== null} onClick={() => void decide(p, "reject")}>
                  Reject
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
