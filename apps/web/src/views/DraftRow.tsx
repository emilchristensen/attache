import type { ActionView } from "@attache/contracts";
import { Tag } from "../components/Tag.tsx";
import { Link } from "../components/ui.tsx";
import { draftAnswers, draftBodyKey, draftOutcome, draftReviewLabel, draftRowText, draftStateTag } from "../approvals.ts";
import { draftHref } from "../routes.ts";
import { ApprovalRow } from "./ApprovalRow.tsx";

/** Where a Draft row stands: waiting for the owner, being sent (In progress), or finished. */
export type DraftRowPlace = "waiting" | "sending" | "finished";

/** What the Draft answers, and its text, read-only: the words are changed only on the Draft's own page. */
function DraftPreview({ d }: { d: ActionView }) {
  const answers = draftAnswers(d);
  const body = d.payload[draftBodyKey(d.kind)];
  return (
    <>
      {(answers.title || answers.quote) && (
        <div className="draft-answers">
          <p className="approval-label">Answers{answers.title ? `: ${answers.title}` : ""}</p>
          {answers.quote && <blockquote className="draft-quote">{answers.quote}</blockquote>}
        </div>
      )}
      <p className="approval-label">Text of v{d.version}</p>
      {typeof body === "string" && body.trim() ? <p className="draft-text">{body}</p> : <p className="draft-text empty">No text yet. Write it on the Draft's page.</p>}
    </>
  );
}

/** The tag after the meta line: the waiting Draft's state when it is not plain, Sending, or the outcome. */
function StateWord({ d, place }: { d: ActionView; place: DraftRowPlace }) {
  if (place === "sending") return <Tag hue="blue">Sending</Tag>;
  if (place === "finished") return <Tag tone={d.status === "failed" || d.status === "unknown" ? "danger" : "outline"}>{draftOutcome(d.status)}</Tag>;
  const tag = draftStateTag(d);
  return tag ? <Tag tone={d.status === "approved" ? "neutral" : "attention"}>{tag}</Tag> : null;
}

/**
 * A Draft's row: its subject, then destination, version and the first line of its text. It opens in place
 * read-only; "Review and approve vN" goes to the Draft's own page, where Approve and Send live (never in the list).
 * A waiting Draft also offers Reject here.
 */
export function DraftRow({ d, place, open, onToggle, reject }: { d: ActionView; place: DraftRowPlace; open: boolean; onToggle: () => void; reject?: { run: (d: ActionView) => void; busy: boolean } }) {
  const text = draftRowText(d);
  return (
    <ApprovalRow
      kind="draft"
      id={d.id}
      subject={text.subject}
      at={d.updatedAt}
      open={open}
      onToggle={onToggle}
      meta={
        <>
          <span>
            {text.destination} · {text.version}
          </span>
          <StateWord d={d} place={place} />
          <span className="approval-preview">{text.preview ?? "No text yet"}</span>
        </>
      }
      detail={
        <>
          <DraftPreview d={d} />
          <div className="approval-actions">
            {place === "waiting" ? (
              <Link to={draftHref(d.id)} className="btn primary">
                {draftReviewLabel(d)}
              </Link>
            ) : (
              <Link to={draftHref(d.id)} className="btn">
                Open the Draft
              </Link>
            )}
            {place === "waiting" && reject && (
              <button disabled={reject.busy} onClick={() => reject.run(d)}>
                Reject
              </button>
            )}
          </div>
        </>
      }
    />
  );
}
