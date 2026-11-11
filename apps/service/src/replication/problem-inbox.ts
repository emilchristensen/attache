import type { Coverage, ReplicationView } from "@jarvis/contracts";
import type { Db } from "../core/db.ts";
import { applyCandidates, type CandidateWithSource } from "../attention/engine.ts";
import { fingerprint } from "../attention/fingerprint.ts";
import { githubRepoOf } from "./github.ts";

/** The inbox source for this Machine's Replication problems. */
export const REPLICATION_SOURCE = "replication";
const PRIORITY = 85;
const STILL_SAVED = "Saves on this Machine keep working, but they do not reach your other Machines until this is fixed.";

function candidate(view: ReplicationView, at: string): CandidateWithSource | null {
  if (view.status !== "blocked" && view.status !== "unauthorized") return null;
  const cause = view.cause ?? "Replication stopped without saying why.";
  const github = view.remote ? githubRepoOf(view.remote) : null;
  const title =
    view.status === "blocked" ? "Replication is blocked" : github?.transport === "https" ? "Reconnect GitHub so Replication can reach the Brain's repository" : "The Brain's repository refused this Machine";
  const why = view.status === "unauthorized" && github?.transport === "https" ? `${STILL_SAVED} Reconnect GitHub in Connections, then check Replication again.` : STILL_SAVED;
  return {
    key: `replication:${view.status}`,
    kind: `replication_${view.status}`,
    title,
    summary: cause,
    why,
    priority: PRIORITY,
    sourceKind: REPLICATION_SOURCE,
    connectionId: null,
    fingerprint: fingerprint([view.status, cause]),
    evidence: [{ label: `Replication with ${view.remote ?? "the Brain's repository"}`, observedAt: view.lastCheckedAt ?? at }],
  };
}

/**
 * One inbox item while Replication is blocked or unauthorized, naming the
 * cause; it resolves itself once Replication is up to date again. Offline is
 * not a problem to act on, so it raises nothing.
 */
export class ReplicationProblems {
  private readonly db: Db;
  private readonly now: () => Date;

  constructor(db: Db, now: () => Date) {
    this.db = db;
    this.now = now;
  }

  /** Bring the inbox in line with the status. Returns whether the inbox changed. */
  update(view: ReplicationView): boolean {
    if (view.status === "offline") return false;
    const at = this.now().toISOString();
    const item = candidate(view, at);
    const coverage: Coverage = { state: "complete", scopes: [], items: item ? 1 : 0, at };
    const r = applyCandidates(this.db, { sourceKind: REPLICATION_SOURCE, connectionId: null, coverage, previousCoverage: coverage }, item ? [item] : []);
    return r.created.length + r.changed.length + r.resolved.length + r.reopened.length > 0;
  }
}
