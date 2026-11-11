import type { Config } from "@jarvis/contracts";
import { type Db, nowIso } from "../core/db.ts";
import type { Logger } from "../core/log.ts";
import { FEATURES, isEnabled } from "../capabilities/registry.ts";

export interface ScheduleRow {
  id: string;
  /** What the schedule does, in the owner's words (from the capability registry). */
  label: string;
  capability: string;
  jobKind: string;
  everyMinutes: number | null;
  dailyAt: string | null;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastJobId: string | null;
}

/** What `Scheduler.enqueue` returns to keep a schedule due: it runs at a later tick, as a catch-up if it waited long. */
export const LATER: unique symbol = Symbol("later");

/** Next local time-of-day occurrence strictly after `from`. */
export function nextDaily(from: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const d = new Date(from.getTime());
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

/** A schedule row's id is `<feature>:<schedule>`; its label comes from the registry entry that defines it. */
function scheduleLabel(capability: string, id: string): string {
  const own = id.slice(capability.length + 1);
  return FEATURES.find((f) => f.id === capability)?.schedules.find((s) => s.id === own)?.label ?? id;
}

/**
 * The only scheduler. It lives in the service (never in a tab or service
 * worker). Schedules are rows derived from the capability registry and the
 * configuration: disabling a capability disables its rows.
 *
 * Sleep and offline: when the host sleeps the process is suspended. On the
 * first tick after waking, every overdue schedule runs ONCE (missed intervals
 * are coalesced, never replayed one by one) and its next run is computed from
 * the current time. A source that is offline records "offline" coverage and is
 * retried on the next interval.
 */
export class Scheduler {
  private readonly db: Db;
  private readonly log: Logger;
  private timer: NodeJS.Timeout | null = null;
  private firstTick: NodeJS.Timeout | null = null;
  private lastTick = Date.now();
  readonly tickMs: number;
  /**
   * Enqueue a job for a due schedule; returns the job id, null when nothing
   * was enqueued, or `LATER` to leave the schedule due and ask again at the next tick.
   */
  enqueue: (row: ScheduleRow, reason: "due" | "catch_up") => string | null | typeof LATER = () => null;
  onResume: (gapMs: number) => void = () => {};

  constructor(db: Db, log: Logger, opts: { tickMs?: number } = {}) {
    this.db = db;
    this.log = log;
    this.tickMs = opts.tickMs ?? 15_000;
  }

  /** Reconcile schedule rows with the registry and configuration. */
  reconcile(config: Config, now = new Date()): ScheduleRow[] {
    for (const f of FEATURES) {
      for (const s of f.schedules) {
        const id = `${f.id}:${s.id}`;
        const enabled = isEnabled(config.features, f.id) && config.setupCompleted && (s.id !== "briefing" || config.schedules.briefingEnabled);
        const every = s.id === "source-refresh" ? config.schedules.refreshEveryMinutes : null;
        const daily = s.id === "briefing" ? config.schedules.briefingAt : null;
        const existing = this.db.prepare("select * from schedules where id = ?").get(id) as Record<string, unknown> | undefined;
        if (!existing) {
          const next = every ? new Date(now.getTime() + 60_000) : nextDaily(now, daily!);
          this.db.prepare("insert into schedules (id, capability, job_kind, every_minutes, daily_at, enabled, next_run_at) values (?,?,?,?,?,?,?)").run(id, f.id, s.jobKind, every, daily, enabled ? 1 : 0, enabled ? next.toISOString() : null);
        } else {
          const wasEnabled = Number(existing.enabled) === 1;
          const cadenceChanged = existing.every_minutes !== every || existing.daily_at !== daily;
          let next = existing.next_run_at as string | null;
          if (enabled && (!wasEnabled || cadenceChanged || !next)) next = (every ? new Date(now.getTime() + 60_000) : nextDaily(now, daily!)).toISOString();
          if (!enabled) next = null;
          this.db.prepare("update schedules set every_minutes = ?, daily_at = ?, enabled = ?, next_run_at = ? where id = ?").run(every, daily, enabled ? 1 : 0, next, id);
        }
      }
    }
    return this.list();
  }

  list(): ScheduleRow[] {
    return (this.db.prepare("select * from schedules order by id").all() as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      label: scheduleLabel(String(r.capability), String(r.id)),
      capability: String(r.capability),
      jobKind: String(r.job_kind),
      everyMinutes: r.every_minutes === null ? null : Number(r.every_minutes),
      dailyAt: (r.daily_at as string) ?? null,
      enabled: Number(r.enabled) === 1,
      nextRunAt: (r.next_run_at as string) ?? null,
      lastRunAt: (r.last_run_at as string) ?? null,
      lastJobId: (r.last_job_id as string) ?? null,
    }));
  }

  start() {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref();
    this.firstTick = setTimeout(() => this.tick(), 1000);
    this.firstTick.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    // The first tick is a one-off timer; left running it fires on a closed database.
    if (this.firstTick) clearTimeout(this.firstTick);
    this.timer = null;
    this.firstTick = null;
  }

  /** Run due schedules. Exposed for tests; `now` can be injected. */
  tick(now = new Date()): Array<{ id: string; jobId: string | null; reason: "due" | "catch_up" }> {
    const gap = now.getTime() - this.lastTick;
    this.lastTick = now.getTime();
    const resumed = gap > this.tickMs * 2 + 5_000;
    if (resumed) {
      this.log.info("host resumed or clock jumped; catching up once", { gapMs: gap });
      this.onResume(gap);
    }
    const due = this.list().filter((s) => s.enabled && s.nextRunAt && s.nextRunAt <= now.toISOString());
    const ran: Array<{ id: string; jobId: string | null; reason: "due" | "catch_up" }> = [];
    for (const s of due) {
      const missedMultiple = s.everyMinutes ? now.getTime() - Date.parse(s.nextRunAt!) > s.everyMinutes * 60_000 : now.getTime() - Date.parse(s.nextRunAt!) > 3_600_000;
      const reason = resumed || missedMultiple ? "catch_up" : "due";
      let jobId: string | null = null;
      try {
        const queued = this.enqueue(s, reason);
        if (queued === LATER) continue;
        jobId = queued;
      } catch (e) {
        this.log.warn("schedule enqueue failed", { id: s.id, error: (e as Error).message });
      }
      const next = s.everyMinutes ? new Date(now.getTime() + s.everyMinutes * 60_000) : nextDaily(now, s.dailyAt!);
      this.db.prepare("update schedules set last_run_at = ?, last_job_id = coalesce(?, last_job_id), next_run_at = ? where id = ?").run(nowIso(), jobId, next.toISOString(), s.id);
      ran.push({ id: s.id, jobId, reason });
    }
    return ran;
  }
}
