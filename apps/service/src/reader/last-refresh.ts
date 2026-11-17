import type { JobView } from "@attache/contracts";
import type { Db } from "../core/db.ts";

/**
 * A Source refresh of every source: a refresh of all sources (scheduled,
 * catch-up, the first one, or started by hand) or a briefing, which refreshes
 * every source first. A refresh of one source does not count.
 */
export function isFullRefresh(job: Pick<JobView, "kind" | "connectionId">): boolean {
  return job.kind === "briefing" || (job.kind === "source-refresh" && job.connectionId === null);
}

/** When this Machine last finished a Source refresh of every source; null when it never has. */
export function lastSourceRefresh(db: Db): string | null {
  const row = db.prepare("select max(finished_at) at from jobs where status = 'succeeded' and (kind = 'briefing' or (kind = 'source-refresh' and connection_id is null))").get() as { at: string | null } | undefined;
  return row?.at ?? null;
}
