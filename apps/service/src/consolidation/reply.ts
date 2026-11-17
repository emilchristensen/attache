import { z } from "zod";
import { MemorySaveItem } from "@attache/contracts";
import { NOTHING_DURABLE } from "../agents/summary.ts";
import type { Completion } from "../models/providers.ts";
import { entriesBeforeTheCut } from "./cut-off.ts";
import { EVIDENCE_MAX_CHARS } from "./prompt.ts";

/** One change the model suggests, in the shape a save takes, before it is checked against the Brain. */
export interface Candidate {
  item: MemorySaveItem;
  reason: string;
  evidence: string;
}

/** What one entry of the reply must hold. The item itself is checked as a save item once the reason is filled in. */
const Entry = z.object({
  item: z.record(z.string(), z.unknown()),
  reason: z.string().trim().min(1).max(1000),
  evidence: z.string().trim().min(1).max(EVIDENCE_MAX_CHARS),
});
// No limit on the entries: the reply's token budget bounds it, and Consolidation keeps every change worth keeping (ADR 0004).
const Reply = z.object({ proposals: z.array(z.unknown()) });

/** Why an entry of the reply was dropped, for the job's log. */
export interface Dropped {
  problem: string;
}

/** Why the change a reply was writing when the model reached its token limit was dropped. */
const CUT_OFF = "the reply reached the model's token limit and was cut off, so the change it was writing is lost";

/**
 * Read the model's reply as candidates. The reply is untrusted data: anything
 * that is not a well-formed entry is dropped, never repaired into a change.
 * A reply cut off at the model's token limit keeps every entry written out in
 * full before the cut, and drops the unfinished one; any other reply that is
 * not the JSON object asked for is dropped whole.
 */
export function parseConsolidationReply(reply: Completion): { candidates: Candidate[]; dropped: Dropped[] } {
  const text = reply.text.trim();
  if (!text || text.toUpperCase().startsWith(NOTHING_DURABLE)) return { candidates: [], dropped: [] };
  const parsed = Reply.safeParse(jsonObject(text));
  if (parsed.success) return readEntries(parsed.data.proposals);
  if (!reply.cutOff) return { candidates: [], dropped: [{ problem: "the reply is not the JSON object Consolidation asks for" }] };
  const { entries, unfinished } = entriesBeforeTheCut(text);
  const read = readEntries(entries);
  return unfinished ? { ...read, dropped: [...read.dropped, { problem: CUT_OFF }] } : read;
}

/** Each entry of the reply as a candidate, or dropped with why it is not one. */
function readEntries(entries: readonly unknown[]): { candidates: Candidate[]; dropped: Dropped[] } {
  const candidates: Candidate[] = [];
  const dropped: Dropped[] = [];
  for (const raw of entries) {
    const entry = Entry.safeParse(raw);
    if (!entry.success) {
      dropped.push({ problem: `an entry lacks an item, a reason or evidence (${firstIssue(entry.error)})` });
      continue;
    }
    const item = MemorySaveItem.safeParse(withFactReasons(entry.data.item, entry.data.reason));
    if (!item.success) {
      dropped.push({ problem: `an item is not a valid save item (${firstIssue(item.error)})` });
      continue;
    }
    candidates.push({ item: item.data, reason: entry.data.reason, evidence: entry.data.evidence });
  }
  return { candidates, dropped };
}

/** The JSON object in the reply, allowing for a code fence or a stray line around it; null when there is none. */
function jsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** An update keeps a reason beside every changed fact; the Proposal's own reason stands in where the model gave none. */
function withFactReasons(item: Record<string, unknown>, reason: string): Record<string, unknown> {
  if (item.action !== "update" || !Array.isArray(item.facts)) return item;
  const facts = item.facts.map((f: unknown) => (f && typeof f === "object" && !("reason" in f) ? { ...f, reason } : f));
  return { ...item, facts };
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  return issue ? `${issue.path.join(".") || "entry"}: ${issue.message}` : "invalid";
}
