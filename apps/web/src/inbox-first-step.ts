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

export function firstStepFor(item: Pick<AttentionItemView, "kind">): FirstStep {
  return Object.hasOwn(FIRST_STEP, item.kind) ? FIRST_STEP[item.kind as InboxKind] : "row";
}
