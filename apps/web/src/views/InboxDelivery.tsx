import { useId, useRef, useState, type ReactNode } from "react";
import type { ActionView, AttentionItemView } from "@attache/contracts";
import { useResource } from "../live.ts";
import { deliveryCheck, replacementWarning } from "../delivery.ts";
import { DraftNoticeLine } from "./DraftParts.tsx";

/** What the open row of an item with Delivery unconfirmed needs from the Inbox. */
export interface DeliveryRowActions {
  prepareReplacement: (item: AttentionItemView, draftId: string) => void;
  viewDraft: (draftId: string) => void;
  busy: boolean;
}

/**
 * The warning and the actions of an open item whose last send has an unknown outcome, above its summary and evidence
 * so that Check destination is the first control in the row's detail: Check destination first
 * (the place the send went, in a new tab; it decides nothing), then the original Draft with its receipt, the item's
 * own link when it goes elsewhere, and Prepare a replacement, which only opens a separate explicit choice.
 * The decisions (Done, Snooze, Dismiss) follow in the row's own `decisions` slot.
 */
export function DeliveryUnconfirmed({ item, draftId, sourceName, canReplace, actions, decisions }: { item: AttentionItemView; draftId: string; sourceName: string; canReplace: boolean; actions: DeliveryRowActions; decisions: ReactNode }) {
  const draft = useResource<ActionView>(`/actions/${draftId}`, ["actions.changed"]);
  const check = deliveryCheck(item, draft.data?.id === draftId ? draft.data : null);
  const notice = useId();
  const choice = useId();
  const [choosing, setChoosing] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const close = () => {
    setChoosing(false);
    toggle.current?.focus();
  };
  return (
    <>
      <DraftNoticeLine notice={check.notice} id={notice} />
      <div className="inbox-actions">
        {check.href && (
          <a className="btn primary" href={check.href} target="_blank" rel="noopener noreferrer" aria-describedby={notice}>
            Check destination
          </a>
        )}
        <button className={check.href ? undefined : "primary"} onClick={() => actions.viewDraft(draftId)}>
          View the Draft
        </button>
        {item.url && item.url !== check.href && (
          <a className="btn" href={item.url} target="_blank" rel="noopener noreferrer">
            Open in {sourceName}
          </a>
        )}
        {canReplace && (
          <button ref={toggle} aria-expanded={choosing} aria-controls={choosing ? choice : undefined} onClick={() => setChoosing(!choosing)}>
            Prepare a replacement
          </button>
        )}
        {decisions}
        {choosing && (
          <div className="inbox-replace" id={choice} role="group" aria-label="Prepare a replacement">
            <p className="inbox-replace-warning">{replacementWarning(item.draftable?.actionKind ?? null)}</p>
            <div className="inbox-replace-actions">
              <button
                className="small"
                disabled={actions.busy}
                onClick={() => {
                  close();
                  actions.prepareReplacement(item, draftId);
                }}
              >
                Prepare a replacement Draft
              </button>
              <button className="small" onClick={close}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
