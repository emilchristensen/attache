import { DatedRecord, isMachineRecordPath } from "./machine-records.ts";
import type { MergeInput, MergeOutcome, MergeRule } from "./seams.ts";

function dated(content: string | null): { content: string; updatedAt: string } | null {
  if (content === null) return null;
  try {
    const parsed = DatedRecord.safeParse(JSON.parse(content));
    return parsed.success ? { content, updatedAt: parsed.data.updatedAt } : null;
  } catch {
    return null;
  }
}

/**
 * Settles a Machine record or the Preferred Reader that two Machines changed:
 * the later choice wins, and a record one side deleted is kept from the other.
 * Every Machine picks the same winner, so they agree without asking the owner.
 */
export const machineRecordRule: MergeRule = {
  name: "machine records",
  appliesTo: isMachineRecordPath,
  merge({ ours, theirs }: MergeInput): MergeOutcome | null {
    const a = dated(ours);
    const b = dated(theirs);
    if (!a || !b) {
      const kept = a ?? b;
      return kept ? { content: kept.content } : null;
    }
    const t = Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
    if (t !== 0) return { content: t > 0 ? a.content : b.content };
    return { content: a.content > b.content ? a.content : b.content };
  },
};
