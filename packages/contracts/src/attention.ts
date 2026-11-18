import { z } from "zod";
import type { ActionStatus } from "./actions.ts";

/** API contract: Attention. */

/**
 * Every Inbox item kind the service raises. A connector can only raise a kind from this list
 * (`AttentionCandidate.kind` is `InboxKind`), and the Dashboard's kind-to-type map is tested against it,
 * so a new kind fails a test until the Dashboard gives it a family, word, hue and icon.
 * An item's `kind` stays a string: a newer Machine can replicate a kind this one does not know.
 */
export const INBOX_KINDS = [
  "deadline",
  "review_request",
  "authored_pr",
  "assigned_issue",
  "pending_reply",
  "mention",
  "invite_response",
  "meeting_prep",
  "overdue_work_item",
  "due_work_item",
  "fact-review",
  "replication_blocked",
  "replication_unauthorized",
  "replication_prose_versions",
  "replication_deleted_and_changed",
] as const;

export type InboxKind = (typeof INBOX_KINDS)[number];

/** The Replication merge notices that become Inbox items, as `replication_<notice kind>`. */
export const MERGE_NOTICE_KINDS = ["prose_versions", "deleted_and_changed"] as const;

export type MergeNoticeKind = (typeof MERGE_NOTICE_KINDS)[number];

export interface AttentionItemView {
  id: string;
  key: string;
  kind: string;
  title: string;
  summary: string;
  why: string | null;
  sourceKind: string;
  connectionId: string | null;
  url: string | null;
  dueAt: string | null;
  priority: number;
  state: "open" | "dismissed" | "snoozed" | "resolved";
  snoozeUntil: string | null;
  evidence: Array<{ label: string; url?: string; relPath?: string; lines?: [number, number]; observedAt: string }>;
  firstSeenAt: string;
  updatedAt: string;
  /** The draft last prepared for this item on this Machine; drafts do not replicate, so another Machine has its own. */
  actionId: string | null;
  /** That draft's status now, or null when there is none. Only a draft in `OPEN_ACTION_STATUSES` still stands for the item. */
  actionStatus: ActionStatus | null;
  changedSinceDecision: boolean;
  draftable: { actionKind: string; target: Record<string, unknown>; context: Record<string, unknown> } | null;
}

export const AttentionDecision = z.object({
  decision: z.enum(["dismiss", "snooze", "reopen", "done"]),
  until: z.string().datetime().optional(),
});

/**
 * `POST /attention/:id/draft`. While the item's last Draft has a send of unknown outcome (`actionStatus` "unknown"),
 * the service refuses a new Draft (`delivery_unconfirmed`) unless `replaceUnconfirmed` says the owner chose to replace it.
 */
export const AttentionDraftInput = z.object({
  instructions: z.string().max(2000).optional(),
  replaceUnconfirmed: z.boolean().optional(),
});

export type AttentionDraftBody = z.infer<typeof AttentionDraftInput>;
