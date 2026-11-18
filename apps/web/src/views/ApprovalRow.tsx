import { useEffect, useId, useRef, type ReactNode } from "react";
import type { ApiError } from "../api.ts";
import { Icon, type IconName } from "../components/icons.tsx";
import { TypeIcon } from "../components/TypeIcon.tsx";
import { Time } from "../components/ui.tsx";
import { clockTime } from "../zoned-time.ts";
import { hueClass, type Hue } from "../theme/hues.ts";

/**
 * The parts every Approvals row shares: the kind mark (a Draft never looks like a Proposal: blue pen and "Draft",
 * plum change glyph and "Proposal"), the row line that opens in place, the one line a decided row leaves behind, and
 * the failure row a group shows for its own request.
 */

export type ApprovalKind = "draft" | "proposal";

export const KIND_MARK: Readonly<Record<ApprovalKind, { icon: IconName; hue: Hue; word: string }>> = {
  draft: { icon: "pen", hue: "blue", word: "Draft" },
  proposal: { icon: "change", hue: "plum", word: "Proposal" },
};

/** The stamp and the word, in the kind's hue. */
export function KindMark({ kind }: { kind: ApprovalKind }) {
  const mark = KIND_MARK[kind];
  return (
    <span className={`approval-kind ${hueClass(mark.hue)}`}>
      <TypeIcon icon={mark.icon} hue={mark.hue} />
      <span className="approval-kind-word">{mark.word}</span>
    </span>
  );
}

interface RowProps {
  kind: ApprovalKind;
  id: string;
  subject: string;
  /** The line under the subject: destination, version and preview, or the change; tags at its end. */
  meta: ReactNode;
  /** When the row last changed. */
  at: string;
  open: boolean;
  onToggle: () => void;
  /** What shows when the row opens in place. */
  detail: ReactNode;
}

/** One row: kind, the subject (the button that opens the row in place, stretched over the line), its meta line and time. */
export function ApprovalRow({ kind, id, subject, meta, at, open, onToggle, detail }: RowProps) {
  const detailId = useId();
  const metaId = useId();
  return (
    <li className={open ? "approval-row open" : "approval-row"} data-approval-row={kind} data-row-id={id}>
      <div className="approval-line">
        <KindMark kind={kind} />
        <div className="approval-main">
          <button className="approval-subject" data-row-toggle aria-expanded={open} aria-controls={open ? detailId : undefined} aria-describedby={metaId} onClick={onToggle}>
            {subject}
          </button>
          <div className="approval-meta" id={metaId}>
            <span className="sr-only">{KIND_MARK[kind].word}, </span>
            {meta}
          </div>
        </div>
        <span className="approval-time">
          <Time iso={at} />
        </span>
      </div>
      {open && (
        <div className="approval-detail" id={detailId}>
          {detail}
        </div>
      )}
    </li>
  );
}

/**
 * A row decided in this visit: one line in its place until the next visit, so nothing below it moves. The line takes
 * focus when the decision was made from it, so the keyboard stays where the owner was.
 */
export function DecidedRow({ kind, id, words, subject, focus, onFocused, after }: { kind: ApprovalKind; id: string; words: string; subject: string; focus: boolean; onFocused?: () => void; after?: ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  // Focus once, right after the decision: a later remount (back from Finished) leaves focus where the owner put it.
  useEffect(() => {
    if (!focus) return;
    ref.current?.focus();
    onFocused?.();
  }, [focus, onFocused]);
  return (
    <li className="approval-row decided" data-approval-row={kind} data-row-id={id} data-decided={words}>
      <div className="approval-line">
        <KindMark kind={kind} />
        <p className="approval-decided" ref={ref} tabIndex={-1}>
          <strong>{words}</strong> · {subject}
        </p>
        {after && <span className="approval-after">{after}</span>}
      </div>
    </li>
  );
}

/**
 * A group's own request failure, on first load or after a good load: what failed, the rows still shown and how old
 * they are, and Retry. Never an empty list. `counted`: the count leaves the group's rows out
 * (it is counting from the lists, and this one failed).
 */
export function GroupFailure({ what, error, answeredAt, retry, retained, counted = false }: { what: string; error: ApiError; answeredAt: number | null; retry: () => void; retained: boolean; counted?: boolean }) {
  const at = answeredAt === null ? null : clockTime(answeredAt, Intl.DateTimeFormat().resolvedOptions().timeZone);
  return (
    <div className="group-failure" role="alert" data-group-failure>
      <Icon name="warning" size={18} />
      <p>
        {retained && at ? (
          <>
            <strong>{what} could not be refreshed.</strong> These are the rows from {at}. They may have changed{counted ? ", and the count leaves them out" : ""}.
          </>
        ) : (
          <>
            <strong>{what} could not be loaded.</strong> This is not an empty list: Attache does not know what is here.
          </>
        )}{" "}
        <span className="group-failure-reason">{error.message}</span>
      </p>
      <button className="small" onClick={retry}>
        Retry
      </button>
    </div>
  );
}
