import { z } from "zod";
import type { AttentionItemView } from "@attache/contracts";

/**
 * One inbox item as it is kept in the Brain (`review/inbox/<key>.json`), so it
 * replicates: what the source said about it (written by the Machine that ran
 * Source refresh) and the owner's latest decision (written by any Machine).
 * Each Machine's database holds the same items, with the state worked out
 * from these two parts.
 *
 * Fields a later release adds, at any level, are kept (`loose`): a Machine
 * that rewrites or merges a record keeps what it does not know (ADR 0008).
 * Its database keeps those of the record and the item in `unknown_fields`.
 */

const MachineRef = z.object({ id: z.string().nullable(), name: z.string() }).loose();
export type InboxMachine = z.infer<typeof MachineRef>;

const Evidence = z.array(
  z.object({
    label: z.string(),
    url: z.string().optional(),
    relPath: z.string().optional(),
    lines: z.tuple([z.number(), z.number()]).optional(),
    observedAt: z.string(),
  }).loose(),
);

const Meeting = z.object({ start: z.string(), end: z.string(), meetLink: z.string().nullable(), attendees: z.array(z.string()) }).loose();

const Draftable = z.object({ actionKind: z.string(), target: z.record(z.string(), z.unknown()), context: z.record(z.string(), z.unknown()) }).loose();

export const InboxItemPart = z.object({
  fingerprint: z.string(),
  kind: z.string(),
  title: z.string(),
  summary: z.string(),
  why: z.string().nullable(),
  sourceKind: z.string(),
  connectionId: z.string().nullable(),
  url: z.string().nullable(),
  dueAt: z.string().nullable(),
  priority: z.number(),
  evidence: Evidence,
  draftable: Draftable.nullable(),
  firstSeenAt: z.string(),
  /** When the source last changed the item. */
  updatedAt: z.string(),
  /** Set when the source no longer reports the item. */
  resolvedAt: z.string().nullable(),
  machine: MachineRef.nullable(),
  /** Meeting prep: the meeting's times and call. Records written before it existed have none. */
  meeting: Meeting.nullable().default(null),
}).loose();
export type InboxItemPart = z.infer<typeof InboxItemPart>;

export const DECISIONS = ["start", "dismiss", "snooze", "reopen", "done"] as const;
export type InboxDecisionKind = (typeof DECISIONS)[number];

export const InboxDecisionPart = z.object({
  decision: z.enum(DECISIONS),
  /** The item's fingerprint when the owner decided: a later change reopens a dismissed item. */
  fingerprint: z.string(),
  until: z.string().nullable(),
  at: z.string(),
  actor: z.string(),
  machine: MachineRef.nullable(),
}).loose();
export type InboxDecisionPart = z.infer<typeof InboxDecisionPart>;

export const INBOX_RECORD_VERSION = 1;

export const InboxRecord = z.object({
  version: z.literal(INBOX_RECORD_VERSION),
  id: z.string().min(1),
  key: z.string().min(1),
  item: InboxItemPart,
  decision: InboxDecisionPart.nullable(),
}).loose();
export type InboxRecord = z.infer<typeof InboxRecord>;

/** The fields of a record and of its item that this release does not know, as a later release wrote them. */
export interface InboxUnknownFields {
  record: Record<string, unknown>;
  item: Record<string, unknown>;
}

function unknownOf(value: object, known: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => !(k in known)));
}

/** Null when the record holds nothing this release does not know. */
export function unknownFieldsOf(rec: InboxRecord): InboxUnknownFields | null {
  const fields = { record: unknownOf(rec, InboxRecord.shape), item: unknownOf(rec.item, InboxItemPart.shape) };
  return Object.keys(fields.record).length || Object.keys(fields.item).length ? fields : null;
}

/** A record read from a file another Machine wrote: untrusted until it parses. */
export function parseInboxRecord(value: unknown): InboxRecord | null {
  const r = InboxRecord.safeParse(value);
  return r.success ? r.data : null;
}

export interface DerivedState {
  state: AttentionItemView["state"];
  snoozeUntil: string | null;
  startedAt: string | null;
  /** The fingerprint the decision applies to; null when there is none, or it was a reopen. */
  decidedFingerprint: string | null;
}

/** Whether the meeting an item is about has reached its scheduled end by `now`. */
export function meetingOver(item: Pick<InboxItemPart, "meeting">, now: string): boolean {
  return !!item.meeting && Date.parse(item.meeting.end) <= Date.parse(now);
}

/**
 * The item's state on this Machine at `now`:
 * resolved by its source or once its meeting has ended, else snoozed while the snooze runs, else dismissed
 * or done while its evidence is what the owner decided on, else open.
 * A meeting's end is worked out from the record on every Machine, so it needs no write that replicates.
 */
export function deriveState(item: Pick<InboxItemPart, "fingerprint" | "resolvedAt" | "meeting">, decision: InboxDecisionPart | null, now: string): DerivedState {
  const decidedFingerprint = decision && decision.decision !== "reopen" ? decision.fingerprint : null;
  const startedAt = decision?.decision === "start" && decision.fingerprint === item.fingerprint ? decision.at : null;
  const base = { snoozeUntil: null, startedAt, decidedFingerprint };
  if (item.resolvedAt || meetingOver(item, now)) return { ...base, state: "resolved", startedAt: null };
  if (decision?.decision === "snooze" && decision.until && decision.until > now) return { ...base, state: "snoozed", snoozeUntil: decision.until };
  if (decision && decision.fingerprint === item.fingerprint) {
    if (decision.decision === "dismiss") return { ...base, state: "dismissed", startedAt: null };
    if (decision.decision === "done") return { ...base, state: "resolved", startedAt: null };
  }
  return { ...base, state: "open" };
}

/** Later wins; at the same moment, the higher Machine id wins, and a known Machine beats an unknown one. */
function later<T extends { machine: InboxMachine | null }>(a: T, b: T, at: (x: T) => string): T {
  if (at(a) !== at(b)) return at(a) > at(b) ? a : b;
  return (a.machine?.id ?? "") >= (b.machine?.id ?? "") ? a : b;
}

/**
 * Two Machines' versions of one item, merged: the source's newer report of the
 * item and the owner's later decision. The item keeps the id and first sighting
 * of whichever Machine saw it first.
 */
export function mergeInboxRecords(a: InboxRecord, b: InboxRecord): InboxRecord {
  const first = a.item.firstSeenAt <= b.item.firstSeenAt ? a : b;
  const item = later(a.item, b.item, (x) => x.updatedAt);
  const decision = a.decision && b.decision ? later(a.decision, b.decision, (d) => d.at) : (a.decision ?? b.decision);
  // Fields this release does not know come from the side with the newer report, as the item does.
  const newer = item === a.item ? a : b;
  return { ...newer, version: INBOX_RECORD_VERSION, id: first.id, key: a.key, item: { ...item, firstSeenAt: first.item.firstSeenAt }, decision };
}
