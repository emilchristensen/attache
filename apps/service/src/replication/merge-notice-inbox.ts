import type { Coverage } from "@jarvis/contracts";
import type { Db } from "../core/db.ts";
import { applyCandidates, type CandidateWithSource } from "../attention/engine.ts";
import { fingerprint } from "../attention/fingerprint.ts";
import type { MergeNotice } from "./seams.ts";

/** Inbox items Replication raises carry this source. */
export const REPLICATION_SOURCE = "replication";
const PRIORITY = 60;

function candidate(notice: MergeNotice, at: string): CandidateWithSource {
  const parts = [notice.kind, notice.path, at];
  return {
    // One item per notice per merge: the same note in a later merge is news again.
    key: `replication:${notice.kind}:${notice.path}:${at}`,
    kind: `replication_${notice.kind}`,
    title: notice.title ?? `Replication merged ${notice.path}`,
    summary: notice.message,
    why: "Two Machines changed the Brain at the same time, and Jarvis settled it without asking.",
    priority: PRIORITY,
    sourceKind: REPLICATION_SOURCE,
    connectionId: null,
    fingerprint: fingerprint(parts),
    evidence: [{ label: notice.path, relPath: notice.path, observedAt: at }],
  };
}

/**
 * Raise one inbox item for each thing a merge rule wants the owner to look at.
 * Only the Machine that made the merge sees the notices, so each is raised once.
 * Nothing resolves these items but the owner's decision.
 */
export function raiseMergeNotices(db: Db, notices: readonly MergeNotice[], at: Date): string[] {
  if (!notices.length) return [];
  const iso = at.toISOString();
  // Never "complete": a merge only reports what it found, so it must not resolve earlier items.
  const coverage: Coverage = { state: "partial", scopes: [], items: notices.length, at: iso };
  return applyCandidates(db, { sourceKind: REPLICATION_SOURCE, connectionId: null, coverage, previousCoverage: null }, notices.map((n) => candidate(n, iso))).created;
}
