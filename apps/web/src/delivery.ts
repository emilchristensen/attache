import type { ActionView, AttentionItemView } from "@attache/contracts";
import { uncertainTargetUrl, unknownOutcomeNotice, type DraftNotice } from "./draft-state.ts";

/**
 * Delivery unconfirmed on an Inbox item (table tests in `test/delivery.test.ts`): the item's last Draft was sent, but
 * the outcome could not be verified. The open row checks the destination first; a replacement Draft takes a separate,
 * explicit choice (the service refuses one otherwise, `delivery_unconfirmed`).
 */

/** The label on the collapsed row. */
export const DELIVERY_UNCONFIRMED = "Delivery unconfirmed";

/** The Draft whose send may have arrived, for an item; null when its linked Draft did not end with an unknown outcome. */
export function unconfirmedDraftId(item: Pick<AttentionItemView, "actionId" | "actionStatus">): string | null {
  return item.actionId && item.actionStatus === "unknown" ? item.actionId : null;
}

/** Where Check destination goes and what the warning says. */
export interface DeliveryCheck {
  /** The receipt's own place, else (a Gmail draft) Gmail's drafts, else the Draft's target, else the item's link; null when none is known. */
  href: string | null;
  notice: DraftNotice;
}

/** Said until the Draft is read (or when it cannot be): no service or receipt to name yet. */
const GENERAL_NOTICE: DraftNotice = { tone: "attention", warning: true, lines: ["The last send could not be verified. It may have arrived. Check the destination before you do anything else."] };

/** Check destination and the warning for an item, from its Draft once read (`null` before). */
export function deliveryCheck(item: Pick<AttentionItemView, "url">, draft: ActionView | null): DeliveryCheck {
  if (!draft) return { href: item.url, notice: GENERAL_NOTICE };
  return { href: uncertainTargetUrl(draft) ?? item.url, notice: unknownOutcomeNotice(draft) };
}

/**
 * The words between Prepare a replacement and the replacement itself, for the item's Draft kind
 * (`item.draftable.actionKind`): a Gmail draft is only created, never sent, so the question is whether it exists.
 */
export function replacementWarning(actionKind: string | null): string {
  return actionKind === "gmail.draft"
    ? "Only if the draft is not in your Gmail drafts. A replacement is a new Draft for this item; nothing reaches Gmail until you approve and create it."
    : "Only if the message did not arrive. A replacement is a new Draft for this item; nothing is sent until you approve and send it.";
}
