import { z } from "zod";
import type { AttentionItemView } from "@jarvis/contracts";

/**
 * One inbox item as it is kept in the Brain (`review/inbox/<key>.json`), so it
 * replicates: what the source said about it (written by the Machine that ran
 * Source refresh) and the owner's latest decision (written by any Machine).
 * Each Machine's database holds the same items, with the state worked out
 * from these two parts.
 */

const MachineRef = z.object({ id: z.string().nullable(), name: z.string() });
export type InboxMachine = z.infer<typeof MachineRef>;

const Evidence = z.array(
  z.object({
    label: z.string(),
    url: z.string().optional(),
    relPath: z.string().optional(),
    lines: z.tuple([z.number(), z.number()]).optional(),
    observedAt: z.string(),
  }),
);

const Draftable = z.object({ actionKind: z.string(), target: z.record(z.string(), z.unknown()), context: z.record(z.string(), z.unknown()) });

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
});
export type InboxItemPart = z.infer<typeof InboxItemPart>;

export const DECISIONS = ["dismiss", "snooze", "reopen", "done"] as const;
export type InboxDecisionKind = (typeof DECISIONS)[number];

export const InboxDecisionPart = z.object({
  decision: z.enum(DECISIONS),
  /** The item's fingerprint when the owner decided: a later change reopens a dismissed item. */
  fingerprint: z.string(),
  until: z.string().nullable(),
  at: z.string(),
  actor: z.string(),
  machine: MachineRef.nullable(),
});
export type InboxDecisionPart = z.infer<typeof InboxDecisionPart>;

export const INBOX_RECORD_VERSION = 1;

export const InboxRecord = z.object({
  version: z.literal(INBOX_RECORD_VERSION),
  id: z.string().min(1),
  key: z.string().min(1),
  item: InboxItemPart,
  decision: InboxDecisionPart.nullable(),
});
export type InboxRecord = z.infer<typeof InboxRecord>;

/** A record read from a file another Machine wrote: untrusted until it parses. */
export function parseInboxRecord(value: unknown): InboxRecord | null {
  const r = InboxRecord.safeParse(value);
  return r.success ? r.data : null;
}

export interface DerivedState {
  state: AttentionItemView["state"];
  snoozeUntil: string | null;
  /** The fingerprint the decision applies to; null when there is none, or it was a reopen. */
  decidedFingerprint: string | null;
}

/**
 * The item's state on this Machine at `now`:
 * resolved by its source, else snoozed while the snooze runs, else dismissed
 * or done while its evidence is what the owner decided on, else open.
 */
export function deriveState(item: Pick<InboxItemPart, "fingerprint" | "resolvedAt">, decision: InboxDecisionPart | null, now: string): DerivedState {
  const decidedFingerprint = decision && decision.decision !== "reopen" ? decision.fingerprint : null;
  const base = { snoozeUntil: null, decidedFingerprint };
  if (item.resolvedAt) return { ...base, state: "resolved" };
  if (decision?.decision === "snooze" && decision.until && decision.until > now) return { ...base, state: "snoozed", snoozeUntil: decision.until };
  if (decision && decision.fingerprint === item.fingerprint) {
    if (decision.decision === "dismiss") return { ...base, state: "dismissed" };
    if (decision.decision === "done") return { ...base, state: "resolved" };
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
  return { version: INBOX_RECORD_VERSION, id: first.id, key: a.key, item: { ...item, firstSeenAt: first.item.firstSeenAt }, decision };
}
