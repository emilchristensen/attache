import type { ReplicationStatus } from "@attache/contracts";
import type { Db } from "../core/db.ts";

/** Replication as this Machine has it set up. Local state: never part of the Brain. */
export interface ReplicationSettings {
  readonly dataFolder: string;
  readonly remote: string;
  readonly enabledAt: string;
  /** The last change-log entry already described in a commit. */
  readonly committedSeq: number;
  readonly status: Exclude<ReplicationStatus, "off">;
  readonly cause: string | null;
  readonly checkedAt: string | null;
  readonly pushedAt: string | null;
  /** The last check that left this Machine up to date; setup and join count as one. */
  readonly upToDateAt: string | null;
  /** While paused: the Brain format, newer than this Machine reads, that paused it. */
  readonly pausedFormat: number | null;
}

interface Row {
  data_folder: string;
  remote: string;
  enabled_at: string;
  committed_seq: number;
  status: string;
  cause: string | null;
  checked_at: string | null;
  pushed_at: string | null;
  up_to_date_at: string | null;
  paused_format: number | null;
}

export class ReplicationSettingsStore {
  private readonly db: Db;

  constructor(db: Db) {
    this.db = db;
  }

  get(): ReplicationSettings | null {
    const r = this.db.prepare("select data_folder, remote, enabled_at, committed_seq, status, cause, checked_at, pushed_at, up_to_date_at, paused_format from replication where id = 1").get() as Row | undefined;
    if (!r) return null;
    return Object.freeze({
      dataFolder: r.data_folder,
      remote: r.remote,
      enabledAt: r.enabled_at,
      committedSeq: Number(r.committed_seq),
      status: r.status as ReplicationSettings["status"],
      cause: r.cause,
      checkedAt: r.checked_at,
      pushedAt: r.pushed_at,
      upToDateAt: r.up_to_date_at,
      pausedFormat: r.paused_format === null ? null : Number(r.paused_format),
    });
  }

  /** Switch Replication on for `dataFolder`, replacing any earlier setup. */
  enable(s: Pick<ReplicationSettings, "dataFolder" | "remote" | "enabledAt" | "committedSeq" | "pushedAt">): ReplicationSettings {
    this.db
      .prepare(
        `insert into replication (id, data_folder, remote, enabled_at, committed_seq, status, cause, checked_at, pushed_at, up_to_date_at) values (1, ?, ?, ?, ?, 'up_to_date', null, ?, ?, ?)
         on conflict(id) do update set data_folder = excluded.data_folder, remote = excluded.remote, enabled_at = excluded.enabled_at, committed_seq = excluded.committed_seq,
           status = excluded.status, cause = null, paused_format = null, checked_at = excluded.checked_at, pushed_at = excluded.pushed_at, up_to_date_at = excluded.up_to_date_at`,
      )
      .run(s.dataFolder, s.remote, s.enabledAt, s.committedSeq, s.enabledAt, s.pushedAt, s.enabledAt);
    return this.get()!;
  }

  committed(seq: number): void {
    this.db.prepare("update replication set committed_seq = max(committed_seq, ?) where id = 1").run(seq);
  }

  /** Record the outcome of a check; `pausedFormat` only with the paused status. */
  report(outcome: { status: ReplicationSettings["status"]; cause: string | null; at: string; pushed: boolean; pausedFormat?: number | null }): void {
    this.db
      .prepare(
        "update replication set status = ?, cause = ?, paused_format = ?, checked_at = ?, pushed_at = case when ? then ? else pushed_at end, up_to_date_at = case when ? = 'up_to_date' then ? else up_to_date_at end where id = 1",
      )
      .run(outcome.status, outcome.cause, outcome.status === "paused" ? (outcome.pausedFormat ?? null) : null, outcome.at, outcome.pushed ? 1 : 0, outcome.at, outcome.status, outcome.at);
  }

  /** Switch Replication off on this Machine: forget the setup, keep the data folder and its history as they are. */
  disable(): void {
    this.db.prepare("delete from replication where id = 1").run();
  }
}
