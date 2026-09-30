import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { JobEvent, JobKind, JobStatus, JobView } from "@jarvis/contracts";
import { type Db, json, nowIso, tx } from "../core/db.ts";
import type { Logger } from "../core/log.ts";
import { redactDeep } from "../core/log.ts";

export interface JobContext {
  job: JobView;
  input: Record<string, unknown>;
  signal: AbortSignal;
  progress(fraction: number, note?: string): void;
  event(type: string, data?: Record<string, unknown>): void;
  checkpoint<T>(): T | null;
  saveCheckpoint(value: unknown): void;
  /**
   * Run an external side effect at most once. The effect key is persisted as
   * pending before the call and done (with its verified result) after it. On
   * recovery, a done effect returns its stored result; a pending effect is
   * looked up with `find` before any retry. Without `find`, a pending effect
   * blocks the job for human review instead of risking a duplicate.
   */
  effect<T>(key: string, run: () => Promise<T>, find?: () => Promise<T | null>): Promise<T>;
}

export type JobRunner = (ctx: JobContext) => Promise<unknown>;

export class JobBlockedError extends Error {}

export interface CreateJob {
  kind: JobKind;
  title: string;
  input: Record<string, unknown>;
  idempotencyKey?: string | undefined;
  capability?: string | null;
  connectionId?: string | null;
  maxAttempts?: number;
  runAfter?: string | null;
}

export class JobQueue {
  readonly events = new EventEmitter();
  private readonly db: Db;
  private readonly log: Logger;
  private readonly owner = randomUUID();
  private readonly runners = new Map<string, JobRunner>();
  private readonly running = new Map<string, AbortController>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private concurrency: number;
  /** Returns a reason string if the job may not run now (capability disabled, connection gone). */
  gate: (job: JobView) => string | null = () => null;
  /** Called when a job ends without succeeding (cancelled, blocked, failed). */
  onUnsuccessful: (job: JobView) => void = () => {};

  constructor(db: Db, log: Logger, opts: { concurrency?: number } = {}) {
    this.db = db;
    this.log = log;
    this.concurrency = opts.concurrency ?? 2;
    this.events.setMaxListeners(200);
  }

  register(kind: string, runner: JobRunner) {
    this.runners.set(kind, runner);
  }

  create(input: CreateJob): { job: JobView; existing: boolean } {
    if (input.idempotencyKey) {
      const found = this.db.prepare("select id from jobs where idempotency_key = ?").get(input.idempotencyKey) as { id: string } | undefined;
      if (found) return { job: this.get(found.id)!, existing: true };
    }
    const id = randomUUID();
    const now = nowIso();
    tx(this.db, () => {
      this.db
        .prepare(
          `insert into jobs (id, kind, title, status, input, attempts, max_attempts, idempotency_key, capability, connection_id, created_at, updated_at, run_after)
           values (?,?,?,?,?,0,?,?,?,?,?,?,?)`,
        )
        .run(id, input.kind, input.title, "queued", JSON.stringify(input.input), input.maxAttempts ?? 3, input.idempotencyKey ?? null, input.capability ?? null, input.connectionId ?? null, now, now, input.runAfter ?? null);
      this.insertEvent(id, "queued", { title: input.title });
    });
    this.kick();
    return { job: this.get(id)!, existing: false };
  }

  get(id: string): JobView | null {
    const r = this.db.prepare("select * from jobs where id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? toView(r) : null;
  }

  list(opts: { status?: string[]; limit?: number; kind?: string } = {}): JobView[] {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.status?.length) {
      where.push(`status in (${opts.status.map(() => "?").join(",")})`);
      args.push(...opts.status);
    }
    if (opts.kind) {
      where.push("kind = ?");
      args.push(opts.kind);
    }
    return (this.db.prepare(`select * from jobs ${where.length ? "where " + where.join(" and ") : ""} order by created_at desc limit ${Math.min(opts.limit ?? 100, 500)}`).all(...args) as Array<Record<string, unknown>>).map(toView);
  }

  eventsSince(afterSeq: number, jobId?: string, limit = 1000): JobEvent[] {
    const rows = (jobId
      ? this.db.prepare("select * from job_events where seq > ? and job_id = ? order by seq limit ?").all(afterSeq, jobId, limit)
      : this.db.prepare("select * from job_events where seq > ? order by seq limit ?").all(afterSeq, limit)) as Array<Record<string, unknown>>;
    return rows.map((r) => ({ seq: Number(r.seq), jobId: String(r.job_id), type: String(r.type), data: json(r.data, {}), at: String(r.at) }));
  }

  private insertEvent(jobId: string, type: string, data: Record<string, unknown> = {}): JobEvent {
    const at = nowIso();
    const safe = redactDeep(data);
    const r = this.db.prepare("insert into job_events (job_id, type, data, at) values (?,?,?,?)").run(jobId, type, JSON.stringify(safe), at);
    const ev: JobEvent = { seq: Number(r.lastInsertRowid), jobId, type, data: safe, at };
    queueMicrotask(() => this.events.emit("event", ev));
    return ev;
  }

  private setStatus(id: string, status: JobStatus, patch: Record<string, unknown> = {}) {
    const cols = Object.keys(patch);
    this.db.prepare(`update jobs set status = ?, updated_at = ?${cols.map((c) => `, ${c} = ?`).join("")} where id = ?`).run(status, nowIso(), ...cols.map((c) => patch[c] as string | number | null), id);
  }

  cancel(id: string, reason = "cancelled by user"): { job: JobView; outcome: "stopped" | "too_late" | "not_started" | "pending" } {
    const job = this.get(id);
    if (!job) throw new Error("not_found");
    if (["succeeded", "failed", "cancelled"].includes(job.status)) {
      this.db.prepare("update jobs set cancel_requested_at = coalesce(cancel_requested_at, ?), cancel_outcome = coalesce(cancel_outcome, 'too_late') where id = ?").run(nowIso(), id);
      this.insertEvent(id, "cancel_too_late", { status: job.status });
      return { job: this.get(id)!, outcome: "too_late" };
    }
    if (job.status === "queued" || job.status === "blocked") {
      tx(this.db, () => {
        this.setStatus(id, "cancelled", { cancel_requested_at: nowIso(), cancel_outcome: "not_started", finished_at: nowIso(), error: reason });
        this.insertEvent(id, "cancelled", { outcome: "not_started", reason });
      });
      this.onUnsuccessful(this.get(id)!);
      return { job: this.get(id)!, outcome: "not_started" };
    }
    this.db.prepare("update jobs set cancel_requested_at = ?, updated_at = ? where id = ?").run(nowIso(), nowIso(), id);
    this.insertEvent(id, "cancel_requested", { reason });
    this.running.get(id)?.abort(new Error(reason));
    return { job: this.get(id)!, outcome: "pending" };
  }

  retry(id: string): JobView {
    const job = this.get(id);
    if (!job) throw new Error("not_found");
    if (!["failed", "cancelled", "blocked"].includes(job.status)) throw new Error(`Only failed, cancelled or blocked jobs can be retried (status: ${job.status})`);
    if (job.kind === "action") throw new Error("Sending is not retried automatically. Approve the draft again to send it.");
    tx(this.db, () => {
      this.db.prepare("update jobs set status = 'queued', error = null, cancel_requested_at = null, cancel_outcome = null, finished_at = null, run_after = null, max_attempts = max(max_attempts, attempts + 1), updated_at = ? where id = ?").run(nowIso(), id);
      this.insertEvent(id, "retry_requested", {});
    });
    this.kick();
    return this.get(id)!;
  }

  /** Cancel queued/running jobs matching a predicate (capability disabled, connection removed). */
  cancelWhere(pred: (j: JobView) => boolean, reason: string): string[] {
    const affected = this.list({ status: ["queued", "running", "blocked"], limit: 500 }).filter(pred);
    for (const j of affected) this.cancel(j.id, reason);
    return affected.map((j) => j.id);
  }

  /** Requeue work orphaned by a previous service process. */
  recover(): string[] {
    const now = nowIso();
    const rows = this.db.prepare("select id, lease_owner, cancel_requested_at from jobs where status = 'running'").all() as Array<{ id: string; lease_owner: string | null; cancel_requested_at: string | null }>;
    const recovered: string[] = [];
    for (const r of rows) {
      if (r.lease_owner === this.owner) continue;
      if (r.cancel_requested_at) {
        // Cancelled before the restart: the interrupted work is not resumed.
        tx(this.db, () => {
          this.setStatus(r.id, "cancelled", { cancel_outcome: "stopped", finished_at: now, lease_owner: null, lease_until: null });
          this.insertEvent(r.id, "cancelled", { outcome: "stopped", note: "Cancelled; the service restarted before the work finished, so it was not resumed." });
        });
        this.onUnsuccessful(this.get(r.id)!);
        continue;
      }
      tx(this.db, () => {
        this.db.prepare("update jobs set status = 'queued', lease_owner = null, lease_until = null, updated_at = ? where id = ?").run(now, r.id);
        this.insertEvent(r.id, "recovered", { note: "Service restarted while this job was running; resuming from its last checkpoint." });
      });
      recovered.push(r.id);
    }
    return recovered;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.recover();
    this.timer = setInterval(() => this.kick(), 1000);
    this.timer.unref();
    this.kick();
  }

  async stop(graceMs = 3000) {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    const deadline = Date.now() + graceMs;
    while (this.running.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }

  kick() {
    if (this.stopped) return;
    queueMicrotask(() => this.pump());
  }

  private pump() {
    if (this.stopped) return;
    while (this.running.size < this.concurrency) {
      const now = nowIso();
      const next = this.db.prepare("select id from jobs where status = 'queued' and (run_after is null or run_after <= ?) order by created_at limit 1").get(now) as { id: string } | undefined;
      if (!next) return;
      const claimed = this.db
        .prepare("update jobs set status = 'running', lease_owner = ?, lease_until = ?, started_at = coalesce(started_at, ?), attempts = attempts + 1, updated_at = ? where id = ? and status = 'queued'")
        .run(this.owner, new Date(Date.now() + 60_000).toISOString(), now, now, next.id);
      if (!claimed.changes) continue;
      void this.execute(next.id);
    }
  }

  private async execute(id: string) {
    const job = this.get(id)!;
    const ctrl = new AbortController();
    this.running.set(id, ctrl);
    const lease = setInterval(() => {
      this.db.prepare("update jobs set lease_until = ? where id = ? and lease_owner = ?").run(new Date(Date.now() + 60_000).toISOString(), id, this.owner);
    }, 20_000);
    lease.unref();
    try {
      const blocked = this.gate(job);
      if (blocked) {
        this.setStatus(id, "blocked", { error: blocked, lease_owner: null });
        this.insertEvent(id, "blocked", { reason: blocked });
        this.onUnsuccessful(this.get(id)!);
        return;
      }
      const runner = this.runners.get(job.kind);
      if (!runner) throw new Error(`No runner for job kind ${job.kind}`);
      this.insertEvent(id, "started", { attempt: job.attempts });
      const ctx = this.context(job, ctrl.signal);
      const result = await runner(ctx);
      // The runner finished; a cancel that arrived meanwhile came too late to stop it.
      const lateCancel = ctrl.signal.aborted || !!this.get(id)!.cancelRequestedAt;
      tx(this.db, () => {
        this.setStatus(id, "succeeded", { result: JSON.stringify(redactDeep(result ?? null)), progress: 1, finished_at: nowIso(), lease_owner: null, ...(lateCancel ? { cancel_outcome: "too_late" } : {}) });
        this.insertEvent(id, "succeeded", { result: (redactDeep(result ?? null) as Record<string, unknown>) ?? null, ...(lateCancel ? { cancelOutcome: "too_late" } : {}) });
      });
    } catch (e) {
      const err = e as Error;
      const current = this.get(id)!;
      if (current.cancelRequestedAt || ctrl.signal.aborted) {
        tx(this.db, () => {
          this.setStatus(id, "cancelled", { cancel_outcome: "stopped", finished_at: nowIso(), error: String(ctrl.signal.reason?.message ?? "cancelled"), lease_owner: null });
          this.insertEvent(id, "cancelled", { outcome: "stopped", note: "Work stopped before completion." });
        });
      } else if (e instanceof JobBlockedError) {
        this.setStatus(id, "blocked", { error: err.message, lease_owner: null });
        this.insertEvent(id, "blocked", { reason: err.message });
      } else if (current.attempts < current.maxAttempts) {
        const delay = Math.min(60_000, 2000 * 2 ** (current.attempts - 1));
        tx(this.db, () => {
          this.setStatus(id, "queued", { error: err.message, run_after: new Date(Date.now() + delay).toISOString(), lease_owner: null });
          this.insertEvent(id, "retry_scheduled", { error: err.message, attempt: current.attempts, inMs: delay });
        });
      } else {
        tx(this.db, () => {
          this.setStatus(id, "failed", { error: err.message, finished_at: nowIso(), lease_owner: null });
          this.insertEvent(id, "failed", { error: err.message, attempts: current.attempts });
        });
      }
      this.log.warn("job ended without success", { id, kind: job.kind, error: err.message });
      const after = this.get(id)!;
      if (["cancelled", "blocked", "failed"].includes(after.status)) this.onUnsuccessful(after);
    } finally {
      clearInterval(lease);
      this.running.delete(id);
      this.kick();
    }
  }

  private context(job: JobView, signal: AbortSignal): JobContext {
    const id = job.id;
    return {
      job,
      input: json(this.db.prepare("select input from jobs where id = ?").get(id)?.input, {}),
      signal,
      progress: (fraction, note) => {
        this.db.prepare("update jobs set progress = ?, progress_note = ?, updated_at = ? where id = ?").run(Math.max(0, Math.min(1, fraction)), note ?? null, nowIso(), id);
        this.insertEvent(id, "progress", { progress: fraction, ...(note ? { note } : {}) });
      },
      event: (type, data = {}) => {
        this.insertEvent(id, type, data);
      },
      checkpoint: <T>() => json<T | null>(this.db.prepare("select checkpoint from jobs where id = ?").get(id)?.checkpoint, null),
      saveCheckpoint: (value) => {
        this.db.prepare("update jobs set checkpoint = ?, updated_at = ? where id = ?").run(JSON.stringify(value), nowIso(), id);
      },
      effect: async <T>(key: string, run: () => Promise<T>, find?: () => Promise<T | null>): Promise<T> => {
        const row = this.db.prepare("select status, result from side_effects where effect_key = ?").get(key) as { status: string; result: string | null } | undefined;
        if (row?.status === "done") {
          this.insertEvent(id, "effect_reused", { key });
          return json<T>(row.result, null as T);
        }
        if (row?.status === "pending") {
          if (!find) throw new JobBlockedError(`An earlier attempt of side effect ${key} may have completed; it cannot be checked automatically, so it will not be repeated.`);
          const found = await find();
          if (found !== null) {
            this.db.prepare("update side_effects set status = 'done', result = ?, completed_at = ? where effect_key = ?").run(JSON.stringify(found), nowIso(), key);
            this.insertEvent(id, "effect_recovered", { key });
            return found;
          }
        } else if (row) {
          // A previous attempt was definitively rejected before anything was created; try again.
          this.db.prepare("update side_effects set status = 'pending', job_id = ?, created_at = ?, completed_at = null where effect_key = ?").run(id, nowIso(), key);
        } else {
          this.db.prepare("insert into side_effects (effect_key, job_id, status, created_at) values (?,?, 'pending', ?)").run(key, id, nowIso());
        }
        if (signal.aborted) throw signal.reason ?? new Error("cancelled");
        const result = await run();
        this.db.prepare("update side_effects set status = 'done', result = ?, completed_at = ? where effect_key = ?").run(JSON.stringify(result), nowIso(), key);
        this.insertEvent(id, "effect_done", { key });
        return result;
      },
    };
  }
}

function toView(r: Record<string, unknown>): JobView {
  return {
    id: String(r.id),
    kind: r.kind as JobKind,
    title: String(r.title),
    status: r.status as JobStatus,
    progress: Number(r.progress ?? 0),
    progressNote: (r.progress_note as string) ?? null,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    result: json(r.result, null),
    error: (r.error as string) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    startedAt: (r.started_at as string) ?? null,
    finishedAt: (r.finished_at as string) ?? null,
    cancelRequestedAt: (r.cancel_requested_at as string) ?? null,
    cancelOutcome: (r.cancel_outcome as JobView["cancelOutcome"]) ?? null,
    capability: (r.capability as string) ?? null,
    connectionId: (r.connection_id as string) ?? null,
  };
}
