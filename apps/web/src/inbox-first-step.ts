import type { AttentionItemView, InboxKind } from "@attache/contracts";

export type FirstStep = "draft" | "source" | "prep" | "calendar" | "row";

export const FIRST_STEP: Readonly<Record<InboxKind, FirstStep>> = {
  deadline: "row",
  review_request: "source",
  authored_pr: "source",
  assigned_issue: "source",
  pending_reply: "draft",
  mention: "draft",
  invite_response: "calendar",
  meeting_prep: "prep",
  overdue_work_item: "source",
  due_work_item: "source",
  "fact-review": "row",
  replication_blocked: "row",
  replication_unauthorized: "row",
  replication_prose_versions: "row",
  replication_deleted_and_changed: "row",
};

/**
 * Start working's first step for an item: the step its kind maps to (`FIRST_STEP`), a kind newer than this map as
 * "row"; and Prepare draft for any other draftable item, one whose kind would only open the row (a source, the event
 * or the prep stays the step its kind names).
 */
export function firstStepFor(item: Pick<AttentionItemView, "kind" | "draftable">): FirstStep {
  const step = Object.hasOwn(FIRST_STEP, item.kind) ? FIRST_STEP[item.kind as InboxKind] : "row";
  return step === "row" && item.draftable ? "draft" : step;
}
