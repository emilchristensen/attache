import { plural, WAITING_ACTION_STATUSES, type ActionView, type Citation } from "@attache/contracts";
import { Disclosure } from "../components/Disclosure.tsx";
import { useOpenEvidence } from "../components/Evidence.tsx";
import { Icon } from "../components/icons.tsx";
import { Tag } from "../components/Tag.tsx";
import { Time } from "../components/ui.tsx";
import { draftAnswers, draftRowText } from "../approvals.ts";
import type { DraftClock, DraftNotice, DraftScreen, DraftStep } from "../draft-state.ts";
import { KindMark } from "./ApprovalRow.tsx";

/**
 * The parts of a Draft's own page that only show what `draft-state.ts` decided: the header, the step line, the
 * notice, the message it answers, the receipt, and the context and history below.
 */

/** Times as the owner reads them, in the browser's zone: "16:36" and "Thu 19 Nov, 16:21". */
export const DRAFT_CLOCK: DraftClock = {
  time: (iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
  day: (iso) => {
    const at = new Date(iso);
    return `${at.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}, ${DRAFT_CLOCK.time(iso)}`;
  },
};

const STATUS_TONE: Partial<Record<DraftScreen["state"], "attention" | "danger" | "outline">> = {
  cannot_send: "attention",
  approval_ended: "attention",
  revoked_by_owner: "attention",
  revoked_by_service: "attention",
  not_sent: "danger",
  unknown: "attention",
  rejected: "outline",
  expired: "outline",
  changed_elsewhere: "attention",
};

/** Kind and destination, the subject, then version, stored status and, while it can still be sent, its expiry. */
export function DraftHeader({ d, screen }: { d: ActionView; screen: DraftScreen }) {
  const text = draftRowText(d);
  const live = WAITING_ACTION_STATUSES.includes(d.status) || d.status === "rejected";
  return (
    <header className="draft-head">
      <p className="draft-kind">
        <KindMark kind="draft" />
        <span className="draft-destination">{text.destination}</span>
      </p>
      <h1 className="draft-title" tabIndex={-1}>{text.subject}</h1>
      <p className="draft-meta">
        <span data-draft-version>{text.version}</span>
        <Tag tone={STATUS_TONE[screen.state] ?? "neutral"}>{screen.status}</Tag>
        {live && (
          <span>
            Expires{" "}
            <time className="time" dateTime={d.expiresAt}>
              {DRAFT_CLOCK.day(d.expiresAt)}
            </time>
          </span>
        )}
      </p>
    </header>
  );
}

const STEP_ICON: Partial<Record<DraftStep["mark"], "check" | "warning" | "question">> = { done: "check", failed: "warning", unknown: "question" };
const STEP_WORD: Record<DraftStep["mark"], string> = { todo: "not yet", current: "current step", done: "done", ended: "ended", failed: "failed", unknown: "not known" };

/** Draft, Approved, Sent: done steps checked, the current one in ink, a failed send red, an unknown outcome brass with "?". */
export function DraftSteps({ steps }: { steps: DraftStep[] }) {
  return (
    <ol className="draft-steps" aria-label="Where the Draft stands">
      {steps.map((s, i) => (
        <li key={i} className="draft-step" data-mark={s.mark} aria-current={s.mark === "current" ? "step" : undefined}>
          <span className="draft-step-dot" aria-hidden>
            {STEP_ICON[s.mark] ? <Icon name={STEP_ICON[s.mark]!} size={14} /> : i + 1}
          </span>
          <span className="draft-step-label">{s.label}</span>
          <span className="sr-only">, {STEP_WORD[s.mark]}</span>
        </li>
      ))}
    </ol>
  );
}

/** What the state means, in words; a failed or uncertain send, and anything brass, carries the warning icon. */
export function DraftNoticeLine({ notice, id }: { notice: DraftNotice; id: string }) {
  return (
    <div className="draft-notice" data-tone={notice.tone} id={id} role="status">
      {notice.warning && <Icon name="warning" size={18} className="draft-notice-icon" />}
      <div>
        {notice.lines.map((line, i) => (
          <p key={i} className={i === 0 && notice.warning ? "draft-notice-lead" : undefined}>
            {line}
          </p>
        ))}
      </div>
    </div>
  );
}

/** The message the Draft answers, quoted in full above its text at every width. */
export function DraftAnswers({ d }: { d: ActionView }) {
  const answers = draftAnswers(d);
  if (!answers.title && !answers.quote) return null;
  return (
    <section className="draft-answers-page" aria-label="What it answers">
      <p className="draft-label">Answers{answers.title ? `: ${answers.title}` : ""}</p>
      {answers.quote && <blockquote className="draft-quote-full">{answers.quote}</blockquote>}
    </section>
  );
}

/** What came back from the other service: when it was verified, its id; for an unknown outcome, when it was recorded and where it went. */
export function DraftReceipt({ d }: { d: ActionView }) {
  if ((d.status !== "succeeded" && d.status !== "unknown") || !d.receipt) return null;
  const r = d.receipt;
  const url = typeof r.url === "string" ? r.url : null;
  return (
    <dl className="kv draft-receipt" data-receipt>
      <dt>Verified</dt>
      <dd>{d.status === "unknown" ? "No, the outcome is unknown" : typeof r.verifiedAt === "string" ? DRAFT_CLOCK.day(r.verifiedAt) : "yes"}</dd>
      {d.status === "unknown" && typeof r.at === "string" && (
        <>
          <dt>Recorded</dt>
          <dd>{DRAFT_CLOCK.day(r.at)}</dd>
        </>
      )}
      {r.remoteId !== undefined && r.remoteId !== null && (
        <>
          <dt>Remote id</dt>
          <dd className="mono">{String(r.remoteId)}</dd>
        </>
      )}
      {d.status === "unknown" && url && (
        <>
          <dt>Address</dt>
          <dd>
            <a href={url} target="_blank" rel="noopener noreferrer">
              {url}
            </a>
          </dd>
        </>
      )}
    </dl>
  );
}

type Context = { item?: { summary?: string }; fetched?: { changedFiles?: Array<{ file: string; additions: number; deletions: number }> }; related?: Citation[]; preparedBy?: string | null };

/** The rest of what the Draft was prepared from: the item's summary, changed files and the notes it cites. */
export function DraftContext({ d }: { d: ActionView }) {
  const open = useOpenEvidence();
  const ctx = d.context as Context;
  const files = ctx.fetched?.changedFiles ?? [];
  const related = ctx.related ?? [];
  if (!ctx.item?.summary && !files.length && !related.length) return null;
  return (
    <section className="draft-context" aria-labelledby="draft-context-title">
      <h2 className="draft-section-title" id="draft-context-title">
        Context
      </h2>
      {ctx.item?.summary && <p>{ctx.item.summary}</p>}
      {files.length > 0 && (
        <Disclosure title={plural(files.length, "changed file")}>
          <ul className="mono draft-files">
            {files.map((f) => (
              <li key={f.file}>
                {f.file} (+{f.additions} −{f.deletions})
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
      {related.length > 0 && (
        <div className="sources">
          {related.map((c) => (
            <button key={c.marker} className="source-chip" onClick={() => open({ root: c.root, relPath: c.relPath, lines: [c.startLine, c.endLine], title: c.title })}>
              <span>{c.title}</span>
              <span className="path">{c.relPath}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

/** Version, hash, who prepared it, and every event, closed until asked for. */
export function DraftHistory({ d }: { d: ActionView }) {
  const preparedBy = (d.context as Context).preparedBy;
  return (
    <Disclosure title="Details and history" meta={plural(d.events.length, "event")} className="draft-history">
      <dl className="kv">
        <dt>Version</dt>
        <dd>
          v{d.version} · <span className="mono">{d.payloadHash.slice(0, 12)}</span>
        </dd>
        {preparedBy && (
          <>
            <dt>Prepared by</dt>
            <dd>{preparedBy}</dd>
          </>
        )}
      </dl>
      <ul className="timeline">
        {d.events.map((e, i) => (
          <li key={i}>
            <Time iso={e.at} />
            <span>
              {e.event.replace(/_/g, " ")} <span className="muted">by {e.actor}</span>
              {e.data && typeof e.data === "object" && "message" in (e.data as Record<string, unknown>) ? <span className="muted">: {String((e.data as Record<string, unknown>).message)}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}
