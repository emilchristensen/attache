import { randomUUID } from "node:crypto";
import { type Db, nowIso } from "../core/db.ts";

/**
 * The change log: every change made to a note, with where it came from, so
 * Recent saves can show and revert it. Kept in this Machine's database.
 */

export interface MemoryChange {
  id: string;
  /** Insertion order: a later change has a higher number, even within one millisecond. */
  seq: number;
  docRelPath: string;
  change: "create" | "correct" | "append" | "proposal" | "delete";
  subject: string | null;
  beforeValue: string | null;
  afterValue: string | null;
  /** For a correction: the fact's Review date before and after it, null when it had none. */
  beforeReview: string | null;
  afterReview: string | null;
  reason: string | null;
  source: string | null;
  actor: string;
  status: "applied" | "proposed" | "rejected";
  createdAt: string;
  decidedAt: string | null;
  /** The Harness (integration kind) and session a save came from, when it came from one. */
  harness: string | null;
  sessionId: string | null;
  /** Shared by every change one save made, so a created note's own events do not block reverting it. */
  batchId: string | null;
  /** The change this one reverted. */
  reverts: string | null;
  /** SHA-256 of the note right after this change, to tell whether anything touched it since. */
  docHash: string | null;
  /** Written without review: a save auto-accept let through, or a Consolidation write. */
  autoAccepted: boolean;
  /** The meeting capture (its path under `evidence/captures/`) a Consolidation write came from. */
  capture: string | null;
}

/** Where a change came from, recorded with it in the change log. */
export interface ChangeMeta {
  harness?: string | null;
  sessionId?: string | null;
  batchId?: string | null;
  reverts?: string | null;
  /** Written without review: a save auto-accept let through, or a Consolidation write. */
  autoAccepted?: boolean;
  capture?: string | null;
}

/** A change as the store records it; the log adds its id, order and times. */
export type NewChange = Omit<MemoryChange, "id" | "seq" | "createdAt" | "decidedAt" | keyof ChangeMeta | "docHash" | "beforeReview" | "afterReview"> & {
  decidedAt?: string | null;
  beforeReview?: string | null;
  afterReview?: string | null;
};

/**
 * Where Consolidation's changes came from, recorded with each in the change
 * log: the Harness and session for a session, the capture's path under
 * `evidence/captures/` for a meeting.
 */
export type ConsolidationFrom = { harness: string; sessionId: string } | { capture: string };

export interface ListChangesOptions {
  relPath?: string;
  status?: string;
  /** Only changes recorded after the change with this `seq`. */
  after?: number;
  /** Only changes written without review (true), or only reviewed ones (false). */
  autoAccepted?: boolean;
  /** Only changes recorded at or after this ISO time. */
  since?: string;
  /** The most changes to read, at most 500; `"all"` reads every match, for a list bounded by its other filters. */
  limit?: number | "all";
}

type Row = Record<string, string | number | null>;

export class ChangeLog {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** Record one change; `docHash` is the note's hash right after it, for an applied change. */
  record(c: NewChange, meta: ChangeMeta, docHash: string | null): MemoryChange {
    const id = randomUUID();
    this.db
      .prepare(
        `insert into memory_changes (id, doc_rel_path, change, subject, before_value, after_value, before_review, after_review, reason, source, actor, status, created_at, decided_at, harness, session_id, batch_id, reverts, doc_hash, auto_accepted, capture)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, c.docRelPath, c.change, c.subject, c.beforeValue, c.afterValue, c.beforeReview ?? null, c.afterReview ?? null, c.reason, c.source, c.actor, c.status, nowIso(), c.decidedAt ?? (c.status === "applied" ? nowIso() : null), meta.harness ?? null, meta.sessionId ?? null, meta.batchId ?? null, meta.reverts ?? null, docHash, meta.autoAccepted ? 1 : 0, meta.capture ?? null);
    return this.get(id)!;
  }

  /** Proposals this Machine stored in its change log before Proposals became files in the Brain, oldest first. */
  legacyProposals(): MemoryChange[] {
    const rows = this.db.prepare("select rowid as seq, * from memory_changes where change = 'proposal' order by rowid").all() as Row[];
    return rows.map(rowToChange);
  }

  /** Drop change-log Proposals once they are files in the Brain. */
  forgetLegacyProposals(ids: readonly string[]): void {
    const del = this.db.prepare("delete from memory_changes where id = ? and change = 'proposal'");
    for (const id of ids) del.run(id);
  }

  /** Every change one save or approval made, newest first. */
  inBatch(batchId: string): MemoryChange[] {
    const rows = this.db.prepare("select rowid as seq, * from memory_changes where batch_id = ? order by rowid desc").all(batchId) as Row[];
    return rows.map(rowToChange);
  }

  get(id: string): MemoryChange | null {
    const r = this.db.prepare("select rowid as seq, * from memory_changes where id = ?").get(id) as Row | undefined;
    return r ? rowToChange(r) : null;
  }

  /** Newest first. */
  list(opts: ListChangesOptions = {}): MemoryChange[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (opts.relPath) {
      where.push("doc_rel_path = ?");
      args.push(opts.relPath);
    }
    if (opts.after !== undefined) {
      where.push("rowid > ?");
      args.push(opts.after);
    }
    if (opts.status) {
      where.push("status = ?");
      args.push(opts.status);
    }
    if (opts.autoAccepted !== undefined) {
      where.push("auto_accepted = ?");
      args.push(opts.autoAccepted ? 1 : 0);
    }
    if (opts.since) {
      where.push("created_at >= ?");
      args.push(opts.since);
    }
    const rows = this.db
      .prepare(`select rowid as seq, * from memory_changes ${where.length ? "where " + where.join(" and ") : ""} order by rowid desc ${opts.limit === "all" ? "" : `limit ${Math.min(opts.limit ?? 100, 500)}`}`)
      .all(...args) as Row[];
    return rows.map(rowToChange);
  }
}

function rowToChange(raw: Record<string, string | number | null>): MemoryChange {
  const r = raw as Record<string, string | null>;
  return {
    id: r.id!,
    seq: Number(raw.seq),
    docRelPath: r.doc_rel_path!,
    change: r.change as MemoryChange["change"],
    subject: r.subject ?? null,
    beforeValue: r.before_value ?? null,
    afterValue: r.after_value ?? null,
    beforeReview: r.before_review ?? null,
    afterReview: r.after_review ?? null,
    reason: r.reason ?? null,
    source: r.source ?? null,
    actor: r.actor!,
    status: r.status as MemoryChange["status"],
    createdAt: r.created_at!,
    decidedAt: r.decided_at ?? null,
    harness: r.harness ?? null,
    sessionId: r.session_id ?? null,
    batchId: r.batch_id ?? null,
    reverts: r.reverts ?? null,
    docHash: r.doc_hash ?? null,
    autoAccepted: Number(raw.auto_accepted) === 1,
    capture: r.capture ?? null,
  };
}
