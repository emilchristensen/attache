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

/**
 * The meeting a meeting prep item is about, as the calendar Connection read it.
 * `start` and `end` are instants (ISO 8601 in UTC); the item stays open until `end`.
 */
export interface MeetingTimes {
  start: string;
  end: string;
  /** The call to join (Google Meet or another conference link), or null when the meeting has none. */
  meetLink: string | null;
  /** The other people invited, by name or email; the owner is left out. */
  attendees: string[];
}

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
  /** Set on meeting prep: when the meeting runs and how to join it; null for every other kind. */
  meeting: MeetingTimes | null;
}

export const AttentionDecision = z.object({
  decision: z.enum(["dismiss", "snooze", "reopen", "done"]),
  until: z.string().datetime().optional(),
});

/**
 * `POST /attention/:id/draft`. While the item's last Draft has a send of unknown outcome (`actionStatus` "unknown"),
 * the service refuses a new Draft (`delivery_unconfirmed`) unless `replaceUnconfirmed` names that Draft: the owner
 * chose to replace exactly the Draft they were warned about.
 */
export const AttentionDraftInput = z.object({
  instructions: z.string().max(2000).optional(),
  replaceUnconfirmed: z.string().min(1).optional(),
});

export type AttentionDraftBody = z.infer<typeof AttentionDraftInput>;

const BriefingLead = z.object({ itemId: z.string().min(1), headline: z.string().min(1).max(160), explanation: z.string().min(1).max(500) });
const BriefingUpdate = z.object({ itemId: z.string().min(1), headline: z.string().min(1).max(160), text: z.string().min(1).max(500) });
const BriefingRelated = z.object({ title: z.string(), relPath: z.string(), lines: z.tuple([z.number(), z.number()]) });
const BriefingItem = z.object({ id: z.string().min(1), title: z.string(), summary: z.string(), url: z.string().nullable(), isNew: z.boolean(), changed: z.boolean(), related: z.array(BriefingRelated).optional() });
const BriefingSection = z.object({ id: z.string(), title: z.string(), items: z.array(BriefingItem) });
const BriefingCounts = z.object({ open: z.number().int().nonnegative(), new: z.number().int().nonnegative(), changed: z.number().int().nonnegative(), drafts: z.number().int().nonnegative(), proposals: z.number().int().nonnegative(), failedSources: z.number().int().nonnegative() });

export const BriefingViewSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["daily", "away", "manual"]),
  createdAt: z.iso.datetime(),
  since: z.string().nullable(),
  summary: z.string(),
  sections: z.array(BriefingSection),
  lead: BriefingLead.nullable(),
  topPicks: z.array(z.string().min(1)).max(5),
  updates: z.array(BriefingUpdate),
  coverage: z.array(z.unknown()),
  counts: BriefingCounts,
  deliverablePath: z.string().nullable(),
});

export type BriefingView = z.infer<typeof BriefingViewSchema>;
