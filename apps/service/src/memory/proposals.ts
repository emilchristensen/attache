import { randomUUID } from "node:crypto";
import { MemorySaveInput, MemorySaveItem, SourceRefInput, type ProposalInput, type ProposalView } from "@jarvis/contracts";
import { json } from "../core/db.ts";
import { HttpError } from "../http/router.ts";
import { normalizeRel } from "./policy.ts";
import { checkItems, writeItem } from "./save-items.ts";
import { formatSource, type MemoryChange, type MemoryStore, type SourceRef } from "./store.ts";

/** The Harness session a Proposal came from, when a Harness made it. */
export type ProposalOrigin = NonNullable<MemorySaveInput["origin"]>;

/** What a Proposal stores: one whole save item, the evidence it cites, and the Harness session it came from. */
interface ProposalPayload {
  item: MemorySaveItem;
  source: SourceRef | null;
  origin: ProposalOrigin | null;
}

/** Who suggests a set of items, why, and from which evidence. */
export interface ProposalMeta {
  reason: string;
  source: SourceRef | null;
  origin?: ProposalOrigin | null;
  proposedBy: string;
}

/** The shape every Proposal had before Proposals carried whole save items: one fact, for an existing note or a new one. */
interface LegacyPayload {
  value?: unknown;
  newDoc?: { type?: unknown; title?: unknown } | null;
}

/**
 * Record a suggested change for the owner to decide in the Dashboard. It is
 * checked like a save first, so a Proposal that could never apply is refused
 * when it is made rather than when the owner clicks Apply.
 */
export function proposeItem(memory: MemoryStore, input: ProposalInput, proposedBy: string): ProposalView {
  return proposeItems(memory, [input.item], { reason: input.reason, source: input.source ?? null, proposedBy })[0]!;
}

/**
 * Record one Proposal per item. The items are checked together, like one
 * save, so one invalid item refuses them all. Callers that need every
 * Proposal or none run this inside a transaction.
 */
export function proposeItems(memory: MemoryStore, items: readonly MemorySaveItem[], meta: ProposalMeta): ProposalView[] {
  requireBrain(memory);
  checkItems(memory, items);
  const origin = meta.origin ?? null;
  return items.map((item) => {
    const payload: ProposalPayload = { item, source: meta.source, origin };
    return toView(memory.propose({ target: targetOf(item), subject: summarize(item), payload, reason: meta.reason, source: meta.source ? formatSource(meta.source) : null, actor: meta.proposedBy }));
  });
}

export function listProposals(memory: MemoryStore, opts: { status?: string; limit?: number } = {}): ProposalView[] {
  return memory.listProposals(opts).map(toView);
}

/**
 * Apply or reject a pending Proposal. Applying checks the item again, because
 * the Brain may have changed since it was proposed, then writes it as one
 * file write; a refusal leaves the Proposal pending and the Brain untouched.
 */
export function decideProposal(memory: MemoryStore, id: string, decision: "apply" | "reject"): ProposalView {
  const row = memory.getChange(id);
  if (!row || row.change !== "proposal") throw new HttpError(404, "not_found", "That Proposal does not exist.");
  if (row.status !== "proposed") throw new HttpError(409, "already_decided", `That Proposal was already ${row.status}.`);
  if (decision === "reject") return toView(memory.settleProposal(id, "rejected"));
  requireBrain(memory);
  const payload = readPayload(row);
  if (!payload) throw new HttpError(409, "unreadable_proposal", "This Proposal can no longer be read, so it cannot be applied. Reject it instead.");
  const [step] = checkItems(memory, [payload.item]);
  // Its own batch id, as a save has, so the changes it makes show and revert as one, citing the Harness session it came from.
  const meta = { harness: payload.origin?.agent ?? null, sessionId: payload.origin?.sessionId || null, batchId: randomUUID() };
  const written = writeItem(memory, step!, payload.source, { actor: "service", provenance: "user-approved" }, meta);
  return toView(memory.settleProposal(id, "applied", written.relPath));
}

function requireBrain(memory: MemoryStore) {
  if (!memory.dataRoot) throw new HttpError(409, "needs_data_folder", "Choose a data folder first.");
}

function toView(row: MemoryChange): ProposalView {
  return {
    id: row.id,
    status: row.status,
    item: readPayload(row)?.item ?? null,
    target: row.docRelPath,
    reason: row.reason,
    source: row.source,
    proposedBy: row.actor,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
  };
}

type StoredProposal = Pick<MemoryChange, "docRelPath" | "subject" | "afterValue" | "reason" | "source" | "createdAt">;

/** One line saying what a stored Proposal changes, for lists such as the briefing. */
export function proposalHeadline(row: StoredProposal): string {
  const item = readPayload(row)?.item;
  if (!item) return "A Proposal that can no longer be read";
  const facts = (item.facts ?? []).map((f) => `${f.subject}: ${f.value}${f.review ? ` (review after ${f.review})` : ""}`);
  const events = item.events?.length ?? 0;
  const parts = [...facts, ...(events ? [`${events} event${events === 1 ? "" : "s"}`] : [])].join("; ");
  const line = item.action === "create" ? `New ${item.type} "${item.title}" (${parts})` : parts;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/** Read what a stored Proposal holds, in either the current or the one-fact shape. Null when it no longer validates. */
function readPayload(row: StoredProposal): ProposalPayload | null {
  const stored = json<Record<string, unknown> | null>(row.afterValue, null);
  if (!stored || typeof stored !== "object") return null;
  if ("item" in stored) {
    const item = MemorySaveItem.safeParse(stored.item);
    const source = stored.source == null ? null : SourceRefInput.safeParse(stored.source);
    if (!item.success || (source && !source.success)) return null;
    const origin = MemorySaveInput.shape.origin.safeParse(stored.origin ?? undefined);
    return { item: item.data, source: source?.data ?? null, origin: (origin.success ? origin.data : undefined) ?? null };
  }
  return readLegacy(row, stored as LegacyPayload);
}

/**
 * A one-fact Proposal made before Proposals carried save items. It becomes the
 * save item it always meant, citing its free-text source the way it used to.
 */
function readLegacy(row: StoredProposal, stored: LegacyPayload): ProposalPayload | null {
  const subject = row.subject ?? "";
  const value = typeof stored.value === "string" ? stored.value : "";
  const candidate = stored.newDoc
    ? { action: "create", type: stored.newDoc.type, title: stored.newDoc.title, facts: [{ subject, value }] }
    : { action: "update", path: row.docRelPath, facts: [{ subject, value, reason: row.reason || "approved proposal" }] };
  const item = MemorySaveItem.safeParse(candidate);
  if (!item.success) return null;
  const source: SourceRef = { kind: "user", ref: row.source || "proposal", observedAt: row.createdAt, ...(row.source ? { label: row.source } : {}) };
  return { item: item.data, source, origin: null };
}

/** Where a Proposal lands: the note it changes, or a placeholder naming the note it would create. */
function targetOf(item: MemorySaveItem): string {
  return item.action === "create" ? `(new ${item.type}: ${item.title})` : normalizeRel(item.path.replace(/^\.\//, ""));
}

/** A short line naming what the item changes, for lists that show one line per Proposal. */
function summarize(item: MemorySaveItem): string {
  const subjects = (item.facts ?? []).map((f) => f.subject);
  const events = item.events?.length ?? 0;
  const parts = [...(subjects.length ? [subjects.join(", ")] : []), ...(events ? [`${events} event${events === 1 ? "" : "s"}`] : [])];
  return parts.join("; ").slice(0, 200);
}
