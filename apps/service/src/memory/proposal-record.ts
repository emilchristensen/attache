import { MemorySaveInput, MemorySaveItem, SourceRefInput, type ProposalView } from "@jarvis/contracts";
import { z } from "zod";
import { latestDecision, ReviewMachine } from "../review-state/decisions.ts";
import { reviewPath } from "../review-state/files.ts";
import type { SourceRef } from "./store.ts";

/** Proposals' folder inside the review-state area: `review/proposals/`. */
export const PROPOSALS_KIND = "proposals";

export const proposalPath = (id: string): string => reviewPath(PROPOSALS_KIND, id);

/** One decision on a Proposal, made on one Machine. Decisions are only ever added. */
export const ProposalDecision = z.object({
  id: z.string().min(1),
  at: z.string().min(1),
  machine: ReviewMachine,
  decision: z.enum(["applied", "rejected"]),
  /** The note an approval wrote. */
  path: z.string().nullable().default(null),
  /** The change-log batch the approval wrote on its Machine, so that Machine can undo it if a later rejection wins. */
  batch: z.string().nullable().default(null),
});
export type ProposalDecision = z.infer<typeof ProposalDecision>;

/** A Proposal as one file in the Brain: what it suggests, where it came from, and every decision on it. */
export const ProposalRecord = z.object({
  version: z.literal(1),
  id: z.string().min(1),
  createdAt: z.string().min(1),
  /** The Machine it was made on. */
  machine: ReviewMachine,
  proposedBy: z.string(),
  /** The note it changes, or "(new <type>: <title>)". */
  target: z.string(),
  subject: z.string().nullable().default(null),
  reason: z.string().nullable().default(null),
  source: SourceRefInput.nullable().default(null),
  /** The cited evidence as the note will show it. */
  sourceText: z.string().nullable().default(null),
  origin: MemorySaveInput.shape.origin.unwrap().nullable().default(null),
  /** The words in the cited evidence the change rests on, quoted from it. */
  evidence: z.string().nullable().default(null),
  /** Checked when read, so a Proposal whose item no longer validates still lists and can be rejected. */
  item: z.unknown(),
  decisions: z.array(ProposalDecision).default([]),
});
export type ProposalRecord = z.infer<typeof ProposalRecord>;

/** The record in a file, or null when the file is not a Proposal. */
export function parseProposalRecord(value: unknown): ProposalRecord | null {
  const r = ProposalRecord.safeParse(value);
  return r.success ? r.data : null;
}

export function proposalItem(record: Pick<ProposalRecord, "item">): MemorySaveItem | null {
  const r = MemorySaveItem.safeParse(record.item);
  return r.success ? r.data : null;
}

export function proposalSource(record: Pick<ProposalRecord, "source">): SourceRef | null {
  return record.source as SourceRef | null;
}

export function proposalStatus(record: Pick<ProposalRecord, "decisions">): ProposalView["status"] {
  return latestDecision(record.decisions)?.decision ?? "proposed";
}

export function toProposalView(record: ProposalRecord): ProposalView {
  const last = latestDecision(record.decisions);
  return {
    id: record.id,
    status: last?.decision ?? "proposed",
    item: proposalItem(record),
    target: (last?.decision === "applied" && last.path) || record.target,
    reason: record.reason,
    source: record.sourceText,
    evidence: record.evidence,
    proposedBy: record.proposedBy,
    createdAt: record.createdAt,
    decidedAt: last?.at ?? null,
    proposedOn: record.machine.name,
    decidedOn: last?.machine.name ?? null,
  };
}

/** One line saying what a Proposal changes, for lists such as the briefing. */
export function proposalHeadline(record: Pick<ProposalRecord, "item">): string {
  const item = proposalItem(record);
  if (!item) return "A Proposal that can no longer be read";
  const facts = (item.facts ?? []).map((f) => `${f.subject}: ${f.value}${f.review ? ` (review after ${f.review})` : ""}`);
  const events = item.events?.length ?? 0;
  const parts = [...facts, ...(events ? [`${events} event${events === 1 ? "" : "s"}`] : [])].join("; ");
  const line = item.action === "create" ? `New ${item.type} "${item.title}" (${parts})` : parts;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}
