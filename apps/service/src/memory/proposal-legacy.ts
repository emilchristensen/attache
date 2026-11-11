import { MemorySaveInput, MemorySaveItem, SourceRefInput } from "@jarvis/contracts";
import { json } from "../core/db.ts";
import type { ReviewMachine } from "../review-state/decisions.ts";
import type { ProposalRecord } from "./proposal-record.ts";
import type { MemoryChange, SourceRef } from "./store.ts";

/** One-fact Proposals, from before Proposals carried whole save items. */
interface OneFactPayload {
  value?: unknown;
  newDoc?: { type?: unknown; title?: unknown } | null;
}

interface Payload {
  item: unknown;
  source: SourceRef | null;
  origin: ProposalRecord["origin"];
}

/**
 * A Proposal this Machine kept in its change log before Proposals moved into
 * the Brain, as the file it becomes. Both stored shapes are read: whole save
 * items, and the older one fact. Its decision, if it had one, was made here.
 */
export function legacyProposalRecord(row: MemoryChange, machine: ReviewMachine): ProposalRecord {
  const payload = readPayload(row);
  const decided = row.status === "applied" || row.status === "rejected";
  return {
    version: 1,
    id: row.id,
    createdAt: row.createdAt,
    machine,
    proposedBy: row.actor,
    target: row.docRelPath,
    subject: row.subject,
    reason: row.reason,
    source: payload.source,
    sourceText: row.source,
    origin: payload.origin,
    // Change-log Proposals never quoted their evidence.
    evidence: null,
    item: payload.item,
    decisions: decided
      ? [{ id: `carried-over-${row.id}`, at: row.decidedAt ?? row.createdAt, machine, decision: row.status as "applied" | "rejected", path: row.status === "applied" ? row.docRelPath : null, batch: null }]
      : [],
  };
}

function readPayload(row: MemoryChange): Payload {
  const stored = json<Record<string, unknown> | null>(row.afterValue, null);
  if (!stored || typeof stored !== "object") return { item: null, source: null, origin: null };
  if ("item" in stored) {
    const source = stored.source == null ? null : SourceRefInput.safeParse(stored.source);
    const origin = MemorySaveInput.shape.origin.safeParse(stored.origin ?? undefined);
    return { item: stored.item, source: source?.success ? (source.data as SourceRef) : null, origin: (origin.success ? origin.data : undefined) ?? null };
  }
  return readOneFact(row, stored as OneFactPayload);
}

/** The save item a one-fact Proposal always meant, citing its free-text source the way it used to. */
function readOneFact(row: MemoryChange, stored: OneFactPayload): Payload {
  const subject = row.subject ?? "";
  const value = typeof stored.value === "string" ? stored.value : "";
  const candidate = stored.newDoc
    ? { action: "create", type: stored.newDoc.type, title: stored.newDoc.title, facts: [{ subject, value }] }
    : { action: "update", path: row.docRelPath, facts: [{ subject, value, reason: row.reason || "approved proposal" }] };
  const item = MemorySaveItem.safeParse(candidate);
  const source: SourceRef = { kind: "user", ref: row.source || "proposal", observedAt: row.createdAt, ...(row.source ? { label: row.source } : {}) };
  return { item: item.success ? item.data : null, source, origin: null };
}
