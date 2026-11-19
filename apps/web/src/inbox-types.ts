import type { AttentionItemView, InboxKind } from "@attache/contracts";
import type { IconName } from "./components/icons.tsx";
import type { Hue } from "./theme/hues.ts";

/**
 * The Inbox's one map from an item's kind (and, where the kind alone is not enough, its source) to the type a row
 * shows: a family for Group by type, the kind word, a hue and a glyph. Colour never carries a type alone; the
 * word and the glyph always come with it. A kind this map does not know shows under Other with a readable word, so
 * a newer service (or a newer Machine replicating to this one) never hides an item.
 */

export type FamilyId = "deadlines" | "reviews" | "replies" | "mentions" | "meetings" | "work" | "facts" | "system" | "other";

/** The families in the order Group by type lists them. */
export const FAMILIES: ReadonlyArray<{ id: FamilyId; label: string }> = [
  { id: "deadlines", label: "Deadlines" },
  { id: "reviews", label: "Reviews" },
  { id: "replies", label: "Replies" },
  { id: "mentions", label: "Mentions" },
  { id: "meetings", label: "Meetings" },
  { id: "work", label: "Work items" },
  { id: "facts", label: "Facts to check" },
  { id: "system", label: "System" },
  { id: "other", label: "Other" },
];

export interface InboxType {
  /** One id per type a row can show, so the type picker counts a Slack DM apart from a Gmail reply. */
  id: string;
  family: FamilyId;
  /** The explicit kind word beside the stamp, such as "Review request". */
  word: string;
  icon: IconName;
  hue: Hue;
}

type Known = Omit<InboxType, "family">;

/** Every kind the service raises (`INBOX_KINDS`) and its family; the unit test fails when the two lists differ. */
export const KIND_FAMILY: Readonly<Record<InboxKind, Exclude<FamilyId, "other">>> = {
  deadline: "deadlines",
  review_request: "reviews",
  authored_pr: "reviews",
  pending_reply: "replies",
  mention: "mentions",
  invite_response: "meetings",
  meeting_prep: "meetings",
  assigned_issue: "work",
  overdue_work_item: "work",
  due_work_item: "work",
  "fact-review": "facts",
  replication_blocked: "system",
  replication_unauthorized: "system",
  replication_prose_versions: "system",
  replication_deleted_and_changed: "system",
};

const JIRA_WORK: Known = { id: "jira_work_item", word: "Jira work item", icon: "ticket", hue: "blue" };

const KIND_TYPE: Readonly<Record<InboxKind, Known>> = {
  deadline: { id: "deadline", word: "Deadline", icon: "clock", hue: "rust" },
  review_request: { id: "review_request", word: "Review request", icon: "fork", hue: "blue" },
  authored_pr: { id: "authored_pr", word: "Authored PR", icon: "pull-request", hue: "blue" },
  pending_reply: { id: "pending_reply", word: "Pending reply", icon: "envelope", hue: "rust" },
  mention: { id: "mention", word: "Mention", icon: "at", hue: "plum" },
  invite_response: { id: "invite_response", word: "Invite response", icon: "calendar-question", hue: "green" },
  meeting_prep: { id: "meeting_prep", word: "Meeting prep", icon: "calendar-notes", hue: "blue" },
  assigned_issue: { id: "assigned_issue", word: "Assigned issue", icon: "checklist", hue: "green" },
  overdue_work_item: JIRA_WORK,
  due_work_item: JIRA_WORK,
  "fact-review": { id: "fact-review", word: "Fact to check", icon: "dated-page", hue: "green" },
  replication_blocked: { id: "replication_blocked", word: "Replication blocked", icon: "blocked-arrows", hue: "rust" },
  replication_unauthorized: { id: "replication_unauthorized", word: "Replication refused", icon: "blocked-arrows", hue: "rust" },
  replication_prose_versions: { id: "replication_prose_versions", word: "Two versions", icon: "split-page", hue: "rust" },
  replication_deleted_and_changed: { id: "replication_deleted_and_changed", word: "Deleted and changed", icon: "split-page", hue: "rust" },
};

/** Types that only the source tells apart: Slack's direct messages and mentions share Gmail's and Confluence's kinds. */
const SOURCE_TYPE: Readonly<Record<string, Partial<Record<InboxKind, Known>>>> = {
  slack: {
    pending_reply: { id: "slack_dm", word: "Slack DM", icon: "bubble", hue: "plum" },
    mention: { id: "slack_mention", word: "Slack mention", icon: "at-bubble", hue: "plum" },
  },
};

const isKnown = (kind: string): kind is InboxKind => Object.hasOwn(KIND_FAMILY, kind);

/** "calendar_event" reads "Calendar event"; an empty kind reads "Other". */
function readable(kind: string): string {
  const words = kind.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Other";
}

export function inboxType(item: Pick<AttentionItemView, "kind" | "sourceKind">): InboxType {
  const { kind, sourceKind } = item;
  if (!isKnown(kind)) return { id: kind, family: "other", word: readable(kind), icon: "document", hue: "slate" };
  return { ...(SOURCE_TYPE[sourceKind]?.[kind] ?? KIND_TYPE[kind]), family: KIND_FAMILY[kind] };
}

/** The word of a type id, such as a picker choice whose items have all gone: a known type's word, else the id made readable. */
export function typeWord(id: string): string {
  const known = [...Object.values(KIND_TYPE), ...Object.values(SOURCE_TYPE).flatMap((types) => Object.values(types))].find((t) => t.id === id);
  return known?.word ?? readable(id);
}
