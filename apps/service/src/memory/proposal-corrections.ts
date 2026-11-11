import type { ProposalCorrection } from "@jarvis/contracts";
import { z } from "zod";
import { HttpError } from "../http/router.ts";
import { sameText } from "./same-text.ts";
import type { CheckedItem } from "./save-items.ts";
import type { MemoryStore } from "./store.ts";

/** A correction as a Proposal file keeps it. */
export const CorrectionRecord = z.object({
  subject: z.string(),
  was: z.object({ value: z.string(), date: z.string(), review: z.string().nullable().default(null) }),
  value: z.string(),
});

/** Values compared as the note shows them: only spacing does not make two values different. */

/**
 * The current facts a checked item gives a different value, with the value
 * each holds now. A new subject, or the same value with only a new Review
 * date, corrects nothing.
 */
export function correctionsOf(memory: MemoryStore, step: CheckedItem): ProposalCorrection[] {
  if (step.action !== "update" || !step.item.facts?.length) return [];
  const state = memory.describe(step.relPath).state;
  return step.item.facts.flatMap((f) => {
    const current = state.find((e) => e.subject.toLowerCase() === f.subject.toLowerCase());
    if (!current || sameText(current.value, f.value)) return [];
    return [{ subject: current.subject, was: { value: current.value, date: current.date, review: current.review ?? null }, value: f.value }];
  });
}

/**
 * Refuse to apply corrections whose old value is no longer current: the owner
 * decided on replacing the value the Proposal showed, not whatever the note
 * says now. The Proposal stays pending, so it can be rejected.
 */
export function assertStillCurrent(memory: MemoryStore, relPath: string, corrections: readonly ProposalCorrection[]): void {
  if (!corrections.length) return;
  const state = memory.describe(relPath).state;
  for (const c of corrections) {
    const current = state.find((e) => e.subject.toLowerCase() === c.subject.toLowerCase());
    if (current && sameText(current.value, c.was.value)) continue;
    const now = current ? `it now says "${current.value}"` : "it was removed";
    throw new HttpError(409, "fact_changed", `"${c.subject}" in ${relPath} changed since this Proposal was made: ${now}, not "${c.was.value}". Reject this Proposal.`);
  }
}
