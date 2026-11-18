import { useId, useState } from "react";
import type { AttentionItemView } from "@attache/contracts";
import { TypeIcon } from "../components/TypeIcon.tsx";
import { Icon } from "../components/icons.tsx";
import { Tag } from "../components/Tag.tsx";
import { useOpenEvidence } from "../components/Evidence.tsx";
import { hueClass } from "../theme/hues.ts";
import { inboxType } from "../inbox-types.ts";
import { draftTag, rowText, rowTime, snoozeChoices, untilText } from "../inbox-rows.ts";
import { openDraftId } from "../linked-draft.ts";
import { DELIVERY_UNCONFIRMED, unconfirmedDraftId } from "../delivery.ts";
import { DeliveryUnconfirmed } from "./InboxDelivery.tsx";

/** What the owner decided in a row; Undo reopens the item. */
export type RowDecision = "done" | "dismiss" | "snooze" | "reopen";

export interface RowActions {
  decide: (item: AttentionItemView, decision: RowDecision, until?: string) => void;
  prepareDraft: (item: AttentionItemView) => void;
  /** The owner's explicit choice to replace a Draft whose send has an unknown outcome. */
  prepareReplacement: (item: AttentionItemView) => void;
  viewDraft: (draftId: string) => void;
  busy: boolean;
}

interface Clock {
  now: number;
  timeZone: string;
}

/** The kind column: the tinted stamp and the explicit kind word. Colour is never alone: glyph and word carry the type too. */
function Kind({ item }: { item: AttentionItemView }) {
  const type = inboxType(item);
  return (
    <span className={`inbox-kind ${hueClass(type.hue)}`}>
      <TypeIcon icon={type.icon} hue={type.hue} />
      <span className="inbox-kind-word">{type.word}</span>
    </span>
  );
}

/** Where the item points in the Brain or an imported folder, for the evidence view. */
function evidenceRoot(item: AttentionItemView): string {
  return item.connectionId === "vault-data" || !item.connectionId ? "data" : `import:${item.connectionId}`;
}

function Evidence({ item }: { item: AttentionItemView }) {
  const open = useOpenEvidence();
  const label = useId();
  const cited = item.evidence.filter((e) => e.relPath || e.url);
  if (!cited.length) return null;
  return (
    <div className="inbox-evidence">
      <span className="inbox-why-label" id={label}>
        Evidence:
      </span>
      <ul aria-labelledby={label}>
        {cited.map((e, n) => (
          <li key={`${e.relPath ?? e.url}:${n}`}>
            {e.relPath ? (
              <button className="source-chip" onClick={() => open({ root: evidenceRoot(item), relPath: e.relPath!, lines: e.lines, title: item.title })}>
                {e.label}
              </button>
            ) : (
              <a className="source-chip" href={e.url} target="_blank" rel="noopener noreferrer">
                {e.label}
                <Icon name="external" size={13} />
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The decisions under an open row: Snooze opens its times in place. */
function Decisions({ item, actions, primaryDone }: { item: AttentionItemView; actions: RowActions; primaryDone: boolean }) {
  const [snoozing, setSnoozing] = useState(false);
  const times = useId();
  if (item.state !== "open")
    return (
      <button onClick={() => actions.decide(item, "reopen")} disabled={actions.busy}>
        Reopen
      </button>
    );
  return (
    <>
      {!primaryDone && (
        <button onClick={() => actions.decide(item, "done")} disabled={actions.busy}>
          Done
        </button>
      )}
      <button aria-expanded={snoozing} aria-controls={times} onClick={() => setSnoozing(!snoozing)}>
        Snooze
      </button>
      <button onClick={() => actions.decide(item, "dismiss")} disabled={actions.busy}>
        Dismiss
      </button>
      {snoozing && (
        <div className="inbox-snooze" id={times} role="group" aria-label="Snooze until">
          {snoozeChoices(new Date()).map((t) => (
            <button key={t.label} className="small" disabled={actions.busy} onClick={() => actions.decide(item, "snooze", t.iso)}>
              {t.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/**
 * The open row: summary, why it is here, evidence, then the main action first and the decisions after it. An item
 * whose last send has an unknown outcome leads with its warning and Check destination, its summary and evidence after.
 */
function Detail({ item, id, actions, draftsOn }: { item: AttentionItemView; id: string; actions: RowActions; draftsOn: boolean }) {
  const unconfirmed = unconfirmedDraftId(item);
  const canDraft = draftsOn && item.draftable !== null && item.state === "open";
  const context = (
    <>
      {item.summary && <p className="inbox-summary">{item.summary}</p>}
      {item.why && (
        <p className="inbox-why">
          <span className="inbox-why-label">Why it is here: </span>
          {item.why}
        </p>
      )}
      <Evidence item={item} />
    </>
  );
  if (unconfirmed)
    return (
      <div className="inbox-detail unconfirmed" id={id}>
        <DeliveryUnconfirmed item={item} draftId={unconfirmed} sourceName={sourceName(item)} canReplace={canDraft} actions={actions} decisions={<Decisions item={item} actions={actions} primaryDone={false} />} />
        <div className="inbox-context">{context}</div>
      </div>
    );
  return (
    <div className="inbox-detail" id={id}>
      {context}
      <MainActions item={item} canDraft={canDraft} actions={actions} />
    </div>
  );
}

/** The service an item comes from, as its source line names it ("GitHub"). */
const sourceName = (item: AttentionItemView) => rowText(item).source.split(" · ")[0]!;

/** The main action first (View draft, Prepare draft or Done), the item's own link, then the decisions. */
function MainActions({ item, canDraft, actions }: { item: AttentionItemView; canDraft: boolean; actions: RowActions }) {
  const draftId = openDraftId(item);
  const primary = draftId ? "view" : canDraft ? "prepare" : item.state === "open" ? "done" : null;
  return (
    <div className="inbox-actions">
      {primary === "view" && (
        <button className="primary" onClick={() => actions.viewDraft(draftId!)}>
          View draft
        </button>
      )}
      {primary === "prepare" && (
        <button className="primary" disabled={actions.busy} onClick={() => actions.prepareDraft(item)}>
          Prepare draft
        </button>
      )}
      {primary === "done" && (
        <button className="primary" disabled={actions.busy} onClick={() => actions.decide(item, "done")}>
          Done
        </button>
      )}
      {item.url && (
        <a className="btn" href={item.url} target="_blank" rel="noopener noreferrer">
          Open in {sourceName(item)}
        </a>
      )}
      <Decisions item={item} actions={actions} primaryDone={primary === "done"} />
    </div>
  );
}

/** Plain exception labels on the source line: a Draft that stands for the item, a send of unknown outcome, a change since a decision, a hidden state. */
function Labels({ item, clock }: { item: AttentionItemView; clock: Clock }) {
  const draft = draftTag(item.actionStatus);
  return (
    <>
      {draft && <Tag hue="blue">{draft}</Tag>}
      {unconfirmedDraftId(item) && <Tag tone="attention">{DELIVERY_UNCONFIRMED}</Tag>}
      {item.changedSinceDecision && item.state === "open" && <Tag tone="attention">Changed since your decision</Tag>}
      {item.state === "snoozed" && item.snoozeUntil && <Tag tone="outline">Snoozed until {untilText(item.snoozeUntil, clock.now, clock.timeZone)}</Tag>}
      {item.state === "dismissed" && <Tag tone="outline">Dismissed</Tag>}
    </>
  );
}

/**
 * One Inbox row: kind (stamp and word), the subject with its source line, and the time. The subject is the button
 * that opens the row in place; the whole line is its click target.
 */
export function InboxRow({ item, open, onToggle, actions, draftsOn, clock }: { item: AttentionItemView; open: boolean; onToggle: () => void; actions: RowActions; draftsOn: boolean; clock: Clock }) {
  const detail = useId();
  const described = useId();
  const text = rowText(item);
  const time = rowTime(item, clock.now, clock.timeZone);
  const type = inboxType(item);
  return (
    <li className={open ? "inbox-row open" : "inbox-row"} data-inbox-row data-item-id={item.id} data-item-key={item.key} data-type={type.id}>
      <div className="inbox-line">
        <Kind item={item} />
        <div className="inbox-main">
          <button className="inbox-subject" data-row-toggle aria-expanded={open} aria-controls={open ? detail : undefined} aria-describedby={described} onClick={onToggle}>
            {text.subject}
          </button>
          <p className="inbox-source" id={described}>
            <span className="sr-only">{type.word}, </span>
            <span>{text.source}</span>
            <Labels item={item} clock={clock} />
            <span className="sr-only">, {time.label}</span>
          </p>
        </div>
        <time className="inbox-time" dateTime={time.iso} title={time.label}>
          {time.text}
        </time>
      </div>
      {open && <Detail item={item} id={detail} actions={actions} draftsOn={draftsOn} />}
    </li>
  );
}

const DECIDED_WORDS: Readonly<Record<RowDecision, string>> = { done: "Done", dismiss: "Dismissed", snooze: "Snoozed", reopen: "Back in the Inbox" };

/** A decided row stays in its place as one line with Undo, so nothing below it moves. */
export function DecidedRow({ item, decision, until, onUndo, busy, clock }: { item: AttentionItemView; decision: RowDecision; until: string | null; onUndo: (() => void) | null; busy: boolean; clock: Clock }) {
  const type = inboxType(item);
  const when = decision === "snooze" && until ? ` until ${untilText(until, clock.now, clock.timeZone)}` : "";
  return (
    <li className="inbox-row decided" data-inbox-row data-item-id={item.id} data-item-key={item.key} data-type={type.id} data-decided={decision}>
      <div className="inbox-line">
        <Kind item={item} />
        <p className="inbox-decided" role="status">
          <strong>
            {DECIDED_WORDS[decision]}
            {when}:
          </strong>{" "}
          <span>{rowText(item).subject}</span>
        </p>
        {onUndo && (
          <button className="small inbox-undo" data-undo onClick={onUndo} disabled={busy}>
            Undo
          </button>
        )}
      </div>
    </li>
  );
}
