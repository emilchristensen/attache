import { approvalEndedAt, plural, type ActionStatus, type ActionView, type MemorySaveItem, type ProposalView } from "@attache/contracts";
import type { Answer } from "./count.ts";

/**
 * The rules behind Approvals (pure, table-tested in `test/approvals.test.ts`): what a collapsed Draft or Proposal row
 * says, when "Nothing waits for your OK." is true, how a row decided in this visit keeps its place, and the order
 * of Finished.
 */

/** What each kind of Draft is, as a word. */
export const DRAFT_KIND_WORDS: Readonly<Record<string, string>> = {
  "github.comment": "GitHub comment",
  "jira.comment": "Jira comment",
  "confluence.comment": "Confluence comment",
  "slack.post": "Slack message",
  "gmail.draft": "Gmail draft",
};

/** The payload field that holds a Draft's text. */
export const draftBodyKey = (kind: string): string => (kind === "slack.post" ? "text" : "body");

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** Where a Draft goes: "GitHub comment on acme/web #42", "Gmail draft to nora@example.com", "Slack reply to Nora". */
function destination(d: Pick<ActionView, "kind" | "target" | "context">): string {
  const t = d.target;
  const source = record(record(d.context).source);
  switch (d.kind) {
    case "github.comment":
      return text(t.repo) && t.number !== undefined ? `GitHub comment on ${String(t.repo)} #${String(t.number)}` : "GitHub comment";
    case "jira.comment":
      return text(t.key) ? `Jira comment on ${String(t.key)}` : "Jira comment";
    case "confluence.comment":
      return text(source.title) ? `Confluence comment on ${String(source.title)}` : "Confluence comment";
    case "gmail.draft":
      return text(t.to) ? `Gmail draft to ${String(t.to)}` : "Gmail draft";
    case "slack.post":
      if (text(source.userName)) return `Slack ${t.thread_ts ? "reply" : "message"} to ${String(source.userName)}`;
      return text(t.channel) ? `Slack message in ${String(t.channel)}` : "Slack message";
    default:
      return DRAFT_KIND_WORDS[d.kind] ?? d.kind;
  }
}

/** A title prefix the destination already says ("Review acme/web#42: ", "Reply to Nora: "). */
const SAID_PREFIX = /^(?:review|reply to|re|mention(?:ed)? in)\b[^:]{0,80}:\s+(?=\S)/i;

export interface DraftRowText {
  /** The Draft's subject, without what the destination already says. */
  subject: string;
  destination: string;
  /** "v2". */
  version: string;
  /** The first line of its text; null while it has none. */
  preview: string | null;
}

export function draftRowText(d: Pick<ActionView, "kind" | "title" | "target" | "payload" | "version" | "context">): DraftRowText {
  const body = typeof d.payload[draftBodyKey(d.kind)] === "string" ? String(d.payload[draftBodyKey(d.kind)]) : "";
  const first = body.split("\n").find((l) => l.trim());
  return { subject: d.title.replace(SAID_PREFIX, ""), destination: destination(d), version: `v${d.version}`, preview: first ? first.trim() : null };
}

/** What a Draft answers: the Inbox item it was prepared from, and the words it replies to. */
export function draftAnswers(d: Pick<ActionView, "context">): { title: string | null; quote: string | null } {
  const ctx = record(d.context);
  const source = record(ctx.source);
  const quote = text(source.body) ?? text(source.text) ?? text(source.snippet) ?? text(source.excerpt) ?? text(source.summary);
  return { title: text(record(ctx.item).title), quote };
}

/** The row's way to the Draft's own page, where Approve and Send live. */
export function draftReviewLabel(d: Pick<ActionView, "status" | "version">): string {
  return d.status === "approved" ? `Review and send v${d.version}` : `Review and approve v${d.version}`;
}

/** The waiting Draft's state when it is not a plain Draft: approved, its approval revoked or run out. */
export function draftStateTag(d: Pick<ActionView, "status" | "version" | "events">): string | null {
  if (d.status === "approved") return "Approved";
  if (d.status === "revoked") return "Approval revoked";
  return approvalEndedAt(d) ? "Approval ended" : null;
}

const OUTCOME: Partial<Record<ActionStatus, string>> = { succeeded: "Sent", failed: "Not sent", unknown: "Outcome unknown", rejected: "Rejected", expired: "Expired" };

/** A finished Draft's outcome as a word. */
export const draftOutcome = (status: ActionStatus): string => OUTCOME[status] ?? status;

/** A decided Proposal's outcome as a word. */
export const proposalOutcome = (status: ProposalView["status"]): string => (status === "applied" ? "Applied" : status === "rejected" ? "Rejected" : "Waiting");

export interface ProposalRowText {
  /** The note it changes, by title (its path when the title cannot be read). */
  note: string;
  /** "New person" when the Proposal makes a note; null for a change to one. */
  added: string | null;
  /** The first part, previous to new for a correction ("Owner: Sam → Nora"), and how many more there are. */
  change: string;
}

const TYPE_WORDS: Readonly<Record<string, string>> = { person: "person", project: "project", decision: "decision", note: "note" };

/** Every part of a Proposal's change, in the order the detail lists them, as one short line each. */
function parts(item: MemorySaveItem, corrections: ProposalView["corrections"]): string[] {
  const was = (subject: string) => corrections.find((c) => c.subject.toLowerCase() === subject.toLowerCase())?.was.value;
  const facts = (item.facts ?? []).map((f) => {
    const old = was(f.subject);
    return `${f.subject}: ${old === undefined ? "" : `${old} → `}${f.value}`;
  });
  return [...facts, ...(item.events ?? []).map((e) => `Event: ${e}`)];
}

export function proposalRowText(p: Pick<ProposalView, "item" | "target" | "noteTitle" | "corrections">): ProposalRowText {
  const note = p.noteTitle ?? p.target;
  if (!p.item) return { note, added: null, change: "This Proposal can no longer be read." };
  const all = parts(p.item, p.corrections);
  const more = all.length - 1;
  const change = all.length ? `${all[0]}${more > 0 ? ` · ${plural(more, "more change")}` : ""}` : "No change";
  return { note, added: p.item.action === "create" ? `New ${TYPE_WORDS[p.item.type] ?? p.item.type}` : null, change };
}

/** "Nothing waits for your OK." is true only when both requests answered with nothing (a feature that is off answered too). */
export function nothingWaits(drafts: Answer<unknown>, proposals: Answer<unknown>): boolean {
  const empty = (a: Answer<unknown>) => a.kind === "off" || (a.kind === "rows" && a.rows.length === 0);
  return empty(drafts) && empty(proposals);
}

export type Entry<T, D> = { kind: "live"; row: T } | { kind: "decided"; id: string; decision: D };

/**
 * The rows of a list as they show, given the ids shown before: a row decided in this visit stays in its place as one
 * line (until the next visit), even after it left the live list; new rows take their live places; a row that left
 * without a decision here leaves.
 */
export function withDecided<T extends { id: string }, D>(previous: readonly string[], live: readonly T[], decided: ReadonlyMap<string, D>): Array<Entry<T, D>> {
  const out: Array<Entry<T, D>> = live.map((row) => {
    const decision = decided.get(row.id);
    return decision === undefined ? { kind: "live", row } : { kind: "decided", id: row.id, decision };
  });
  const liveIds = new Set(live.map((r) => r.id));
  previous.forEach((id, index) => {
    const decision = decided.get(id);
    if (liveIds.has(id) || decision === undefined) return;
    // After the row that came before it, or first when nothing before it is still shown.
    const before = previous.slice(0, index).reverse().find((p) => out.some((e) => entryId(e) === p));
    const at = before === undefined ? 0 : out.findIndex((e) => entryId(e) === before) + 1;
    out.splice(at, 0, { kind: "decided", id, decision });
  });
  return out;
}

export const entryId = <T extends { id: string }, D>(e: Entry<T, D>): string => (e.kind === "live" ? e.row.id : e.id);

export type FinishedRow = { kind: "draft"; at: string; row: ActionView } | { kind: "proposal"; at: string; row: ProposalView };

/** Finished Drafts and decided Proposals in one list, the latest outcome first. */
export function finishedRows(drafts: readonly ActionView[], proposals: readonly ProposalView[]): FinishedRow[] {
  const rows: FinishedRow[] = [...drafts.map((row) => ({ kind: "draft" as const, at: row.updatedAt, row })), ...proposals.map((row) => ({ kind: "proposal" as const, at: row.decidedAt ?? row.createdAt, row }))];
  return rows.toSorted((a, b) => (a.at === b.at ? a.row.id.localeCompare(b.row.id) : a.at < b.at ? 1 : -1));
}
