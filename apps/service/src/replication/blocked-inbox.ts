import type { Coverage, InboxKind, ReplicationView } from "@attache/contracts";
import type { Db } from "../core/db.ts";
import { applyCandidates, type CandidateWithSource } from "../attention/engine.ts";
import { fingerprint } from "../attention/fingerprint.ts";
import { githubRepoOf } from "./github.ts";

/** Inbox items about this Machine's Replication. They are local: each Machine reports its own. */
export const REPLICATION_SOURCE = "replication";
const PRIORITY = 80;
const STILL_WORKING = "Other Machines do not get this Machine's changes until the cause is fixed. Saving and search keep working here.";

/** Replication reports on every check, so an item it no longer raises can be resolved at once. */
function covered(items: number, at: string): Coverage {
  return { state: "complete", scopes: [], items, at };
}

function item(key: string, kind: InboxKind, title: string, why: string, cause: string, at: string): CandidateWithSource {
  return {
    key,
    kind,
    title,
    summary: cause,
    why,
    priority: PRIORITY,
    sourceKind: REPLICATION_SOURCE,
    connectionId: null,
    // One item per cause: the same cause stays dismissed, a new one reopens it.
    fingerprint: fingerprint([key, cause]),
    evidence: [{ label: "Replication status", observedAt: at }],
  };
}

/** The item the status calls for: blocked names the cause, unauthorized asks the owner to reconnect. */
function itemFor(view: ReplicationView, at: string): CandidateWithSource | null {
  if (!view.cause) return null;
  if (view.status === "blocked") return item("replication:blocked", "replication_blocked", "Replication is blocked", STILL_WORKING, view.cause, at);
  if (view.status !== "unauthorized") return null;
  if (view.remote && githubRepoOf(view.remote)?.transport === "https") {
    return item("replication:unauthorized", "replication_unauthorized", "Reconnect GitHub so Replication can reach the Brain's repository", `Reconnect GitHub in Connections, then check Replication again. ${STILL_WORKING}`, view.cause, at);
  }
  return item("replication:unauthorized", "replication_unauthorized", "The Brain's repository refused this Machine", `Check that git on this Machine can reach the repository. ${STILL_WORKING}`, view.cause, at);
}

/**
 * Keep the inbox in step with Replication's status: one item while it is
 * blocked or unauthorized, naming the cause, resolved when it is neither.
 * Returns whether the inbox changed.
 */
export function syncReplicationItems(db: Db, view: ReplicationView, at: string): boolean {
  const found = itemFor(view, at);
  const candidates = found ? [found] : [];
  const coverage = covered(candidates.length, at);
  const r = applyCandidates(db, { sourceKind: REPLICATION_SOURCE, connectionId: null, coverage, previousCoverage: coverage }, candidates);
  return r.created.length + r.changed.length + r.resolved.length + r.reopened.length > 0;
}
