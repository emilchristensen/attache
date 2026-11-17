import { OPEN_ACTION_STATUSES, type AttentionItemView } from "@attache/contracts";

/**
 * The draft an attention item's "View draft" opens, or null when the item offers "Prepare draft".
 * A finished draft (rejected, expired, sent, failed) no longer stands for the item, so it can be drafted again;
 * the finished draft stays listed under Drafts.
 */
export function openDraftId(item: Pick<AttentionItemView, "actionId" | "actionStatus">): string | null {
  return item.actionId && item.actionStatus && OPEN_ACTION_STATUSES.includes(item.actionStatus) ? item.actionId : null;
}
