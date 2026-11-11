import type { Coverage, ReplicationView } from "@jarvis/contracts";
import type { Db } from "../core/db.ts";
import { applyCandidates, type CandidateWithSource } from "../attention/engine.ts";
import { fingerprint } from "../attention/fingerprint.ts";

/** Inbox items about this Machine's Replication. They are local: each Machine reports its own. */
export const REPLICATION_SOURCE = "replication";
const ITEM_KEY = "replication:blocked";
const PRIORITY = 80;

/** Replication reports on every check, so an item it no longer raises can be resolved at once. */
function covered(items: number, at: string): Coverage {
  return { state: "complete", scopes: [], items, at };
}

function blockedItem(cause: string, at: string): CandidateWithSource {
  return {
    key: ITEM_KEY,
    kind: "replication_blocked",
    title: "Replication is blocked",
    summary: cause,
    why: "Other Machines do not get this Machine's changes until the cause is fixed. Saving and search keep working here.",
    priority: PRIORITY,
    sourceKind: REPLICATION_SOURCE,
    connectionId: null,
    // One item per cause: the same cause stays dismissed, a new one reopens it.
    fingerprint: fingerprint([ITEM_KEY, cause]),
    evidence: [{ label: "Replication status", observedAt: at }],
  };
}

/**
 * Keep the inbox in step with Replication's status: one item while it is
 * blocked, naming the cause, resolved when it is not. Returns whether the
 * inbox changed.
 */
export function syncBlockedItem(db: Db, view: ReplicationView, at: string): boolean {
  const candidates = view.status === "blocked" && view.cause ? [blockedItem(view.cause, at)] : [];
  const coverage = covered(candidates.length, at);
  const r = applyCandidates(db, { sourceKind: REPLICATION_SOURCE, connectionId: null, coverage, previousCoverage: coverage }, candidates);
  return r.created.length + r.changed.length + r.resolved.length > 0;
}
