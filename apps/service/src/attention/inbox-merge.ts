import type { MergeInput, MergeOutcome, MergeRule } from "../replication/seams.ts";
import { decodeReviewFile, encodeReviewFile, isReviewPath } from "../review-state/files.ts";
import { mergeInboxRecords, parseInboxRecord } from "./inbox-record.ts";

/**
 * Settles an inbox item both Machines changed: the source's newer report of
 * the item, and the owner's later decision. An item one side deleted stays
 * deleted (the owner deleted a disconnected source's data). A side Attache
 * cannot read gives way to the one it can.
 */
export const inboxMergeRule: MergeRule = {
  name: "inbox: latest decision wins",
  appliesTo: (path) => isReviewPath(path, "inbox"),
  merge(input: MergeInput): MergeOutcome | null {
    if (input.ours === null || input.theirs === null) return { content: null };
    const ours = parseInboxRecord(decodeReviewFile(input.ours));
    const theirs = parseInboxRecord(decodeReviewFile(input.theirs));
    if (ours && theirs) return ours.key === theirs.key ? { content: encodeReviewFile(mergeInboxRecords(ours, theirs)) } : null;
    if (ours) return { content: input.ours };
    if (theirs) return { content: input.theirs };
    return null;
  },
};
