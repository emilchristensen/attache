import type { MergeInput, MergeOutcome, MergeRule } from "../replication/seams.ts";
import { decisionOrder, latestDecision, mergeDecisions } from "../review-state/decisions.ts";
import { decodeReviewFile, encodeReviewFile, isReviewPath } from "../review-state/files.ts";
import { parseProposalRecord, PROPOSALS_KIND, type ProposalRecord } from "./proposal-record.ts";

function parse(text: string | null): ProposalRecord | null {
  const raw = decodeReviewFile(text);
  return raw === null ? null : parseProposalRecord(raw);
}

/** The side whose latest decision came later; ours when neither is later. */
function newer(ours: ProposalRecord, theirs: ProposalRecord): ProposalRecord {
  const a = latestDecision(ours.decisions);
  const b = latestDecision(theirs.decisions);
  if (!b) return ours;
  if (!a) return theirs;
  return decisionOrder(a, b) < 0 ? theirs : ours;
}

/**
 * A Proposal both Machines changed, typically decided on both while apart:
 * every decision is kept, and the latest one stands. A Machine that removed
 * the file wins over one that changed it, as for every review-state file.
 */
export const proposalMergeRule: MergeRule = {
  name: "proposals: latest decision wins",
  appliesTo: (path) => isReviewPath(path, PROPOSALS_KIND),
  merge(input: MergeInput): MergeOutcome | null {
    if (input.ours === null || input.theirs === null) return { content: null };
    const ours = parse(input.ours);
    const theirs = parse(input.theirs);
    if (!ours && !theirs) return null;
    // A side that no longer reads as a Proposal holds nothing a Machine could act on.
    if (!ours || !theirs) return { content: encodeReviewFile(ours ?? theirs) };
    const merged: ProposalRecord = { ...newer(ours, theirs), decisions: mergeDecisions(ours.decisions, theirs.decisions) };
    return { content: encodeReviewFile(merged) };
  },
};
