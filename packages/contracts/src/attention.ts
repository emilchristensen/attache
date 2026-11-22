import { z } from "zod";
import type { ActionStatus } from "./actions.ts";
import { Coverage } from "./features.ts";

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
  startedAt: string | null;
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
  decision: z.enum(["start", "dismiss", "snooze", "reopen", "done"]),
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

/** The longest headline a briefing stores for its lead or an update, in characters. */
export const BRIEFING_HEADLINE_MAX = 160;
/** The longest explanation or update text a briefing stores, in characters. */
export const BRIEFING_TEXT_MAX = 500;
/** How many open Inbox items a briefing picks, in the Inbox's order. */
export const BRIEFING_TOP_PICKS = 5;

/** One line of words a model may write: no line breaks, within the stored limit. */
const line = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\n]*$/u);

/** The lead: the first of the top picks, with a headline and a short explanation. */
export const BriefingLead = z.object({ itemId: z.string().min(1), headline: line(BRIEFING_HEADLINE_MAX), explanation: line(BRIEFING_TEXT_MAX) });
export type BriefingLead = z.infer<typeof BriefingLead>;
/** An update text: for an item the briefing flags as new or changed, a headline and one or two sentences. */
export const BriefingUpdate = z.object({ itemId: z.string().min(1), headline: line(BRIEFING_HEADLINE_MAX), text: line(BRIEFING_TEXT_MAX) });
export type BriefingUpdate = z.infer<typeof BriefingUpdate>;

/**
 * What a model returns for a briefing: words only. The lead's item and the update items are chosen by fixed rules
 * before the model is asked, so the model names no lead item; it may only word the updates for the items it was given.
 */
export const BriefingModelWords = z.object({
  summary: z.string().trim().min(1).max(BRIEFING_TEXT_MAX * 2),
  lead: z.object({ headline: line(BRIEFING_HEADLINE_MAX), explanation: line(BRIEFING_TEXT_MAX) }).nullable(),
  updates: z.array(BriefingUpdate),
});
export type BriefingModelWords = z.infer<typeof BriefingModelWords>;

const BriefingRelated = z.object({ title: z.string(), relPath: z.string(), lines: z.tuple([z.number(), z.number()]) });
export type BriefingRelatedNote = z.infer<typeof BriefingRelated>;
const BriefingItem = z.object({ id: z.string().min(1), title: z.string(), summary: z.string(), url: z.string().nullable(), isNew: z.boolean(), changed: z.boolean(), related: z.array(BriefingRelated).optional() });
const BriefingSection = z.object({ id: z.string(), title: z.string(), items: z.array(BriefingItem) });
const BriefingCounts = z.object({ open: z.number().int().nonnegative(), new: z.number().int().nonnegative(), changed: z.number().int().nonnegative(), drafts: z.number().int().nonnegative(), proposals: z.number().int().nonnegative(), failedSources: z.number().int().nonnegative() });

/** What a briefing knew of one source when it was written. */
export const BriefingSourceCoverage = z.object({ id: z.string(), label: z.string(), kind: z.string(), coverage: Coverage.nullable(), lastSuccessAt: z.string().nullable(), status: z.string() });
export type BriefingSourceCoverage = z.infer<typeof BriefingSourceCoverage>;

export const BriefingViewSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["daily", "away", "manual"]),
  createdAt: z.iso.datetime(),
  since: z.string().nullable(),
  summary: z.string(),
  sections: z.array(BriefingSection),
  lead: BriefingLead.nullable(),
  topPicks: z.array(z.string().min(1)).max(BRIEFING_TOP_PICKS),
  updates: z.array(BriefingUpdate),
  coverage: z.array(BriefingSourceCoverage),
  counts: BriefingCounts,
  deliverablePath: z.string().nullable(),
});

export type BriefingView = z.infer<typeof BriefingViewSchema>;

/** `GET /briefings`: the latest Daily Briefing, and the latest away summary or briefing the owner asked for. */
export interface BriefingsResponse {
  daily: BriefingView | null;
  requested: BriefingView | null;
}
