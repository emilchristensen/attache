import type { ProposalView } from "@attache/contracts";
import { json, placeholders, type Db } from "../core/db.ts";
import { latestDecision } from "../review-state/decisions.ts";
import { parseProposalRecord, proposalStatus, type ProposalRecord } from "./proposal-record.ts";

const MAX_LIST = 500;

/**
 * This Machine's index of the Proposal files in the Brain, so lists are one
 * query. The files are the truth: the index is rebuilt from them and never
 * replicates.
 */
export class ProposalIndex {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  put(relPath: string, record: ProposalRecord): void {
    const decidedAt = latestDecision(record.decisions)?.at ?? null;
    this.db
      .prepare(
        `insert into proposals (id, rel_path, status, created_at, decided_at, record) values (?, ?, ?, ?, ?, ?)
         on conflict(id) do update set rel_path = excluded.rel_path, status = excluded.status, created_at = excluded.created_at, decided_at = excluded.decided_at, record = excluded.record`,
      )
      .run(record.id, relPath, proposalStatus(record), record.createdAt, decidedAt, JSON.stringify(record));
  }

  /** Forget the Proposal kept in `relPath`; true when there was one. */
  removePath(relPath: string): boolean {
    return this.db.prepare("delete from proposals where rel_path = ?").run(relPath).changes > 0;
  }

  get(id: string): { relPath: string; record: ProposalRecord } | null {
    const row = this.db.prepare("select rel_path, record from proposals where id = ?").get(id) as { rel_path: string; record: string } | undefined;
    const record = row ? parseProposalRecord(json(row.record, null)) : null;
    return row && record ? { relPath: row.rel_path, record } : null;
  }

  /** The Proposals in any of `statuses` (every one when empty), the latest made or decided first. */
  list(opts: { statuses?: readonly ProposalView["status"][]; limit?: number } = {}): ProposalRecord[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, MAX_LIST));
    const statuses = opts.statuses ?? [];
    const where = statuses.length ? `where status in (${placeholders(statuses)})` : "";
    const rows = this.db.prepare(`select record from proposals ${where} order by coalesce(decided_at, created_at) desc, id limit ?`).all(...statuses, limit) as Array<{ record: string }>;
    return rows.flatMap((r) => parseProposalRecord(json(r.record, null)) ?? []);
  }

  /** How many Proposals are in this status, without the list's limit. */
  count(status: ProposalView["status"]): number {
    return Number((this.db.prepare("select count(*) n from proposals where status = ?").get(status) as { n: number }).n);
  }

  paths(): Map<string, string> {
    const rows = this.db.prepare("select id, rel_path from proposals").all() as Array<{ id: string; rel_path: string }>;
    return new Map(rows.map((r) => [r.rel_path, r.id]));
  }

  /** Same record as indexed already, so a reload can skip it. */
  holds(relPath: string, record: ProposalRecord): boolean {
    const row = this.db.prepare("select record from proposals where rel_path = ?").get(relPath) as { record: string } | undefined;
    return row?.record === JSON.stringify(record);
  }

  clear(): void {
    this.db.prepare("delete from proposals").run();
  }
}
