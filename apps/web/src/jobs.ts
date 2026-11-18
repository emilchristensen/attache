import { plural, type JobEvent, type JobKind, type JobView } from "@attache/contracts";
import { clockTime, sameDay, spokenTime, startOfDay } from "./zoned-time.ts";

/**
 * Jobs' rules, pure so they can be table-tested (`apps/web/test/jobs.test.ts`).
 * The screen lists queued and running work under Running, then everything that ended, newest first.
 */

/** Statuses of work that has not ended: listed under Running and cancellable. */
export const ACTIVE_STATUSES = ["queued", "running"] as const;
/** Statuses of work that ended: listed under Finished, a page at a time. */
export const ENDED_STATUSES = ["succeeded", "failed", "cancelled", "blocked"] as const;

const newestFirst = (a: JobView, b: JobView) => b.createdAt.localeCompare(a.createdAt);

/** Whether a job still needs the owner: it failed, or it is blocked on something they can fix. */
export function needsOwner(job: JobView): boolean {
  return job.status === "failed" || job.status === "blocked";
}

/**
 * The job the detail pane opens on: the running job, else the newest failed or blocked one, else the newest job.
 * The screen calls this once, when both lists first answer; a live update never calls it again.
 */
export function initialJobId(active: readonly JobView[], ended: readonly JobView[]): string | null {
  const all = [...active, ...ended].sort(newestFirst);
  const pick = all.find((j) => j.status === "running") ?? all.find(needsOwner) ?? all[0];
  return pick?.id ?? null;
}

/** The Running group: running work first, newest first, then queued work in the order it will start. */
export function runningOrder(active: readonly JobView[]): JobView[] {
  const running = active.filter((j) => j.status === "running").sort(newestFirst);
  const queued = active.filter((j) => j.status !== "running").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return [...running, ...queued];
}

/** A row's result in a few words, with a tag only when the job failed or is blocked (a success carries none). */
export interface JobSummary {
  tag: "Failed" | "Blocked" | null;
  words: string;
}

type Result = Record<string, unknown>;

/** The first line of a reason: the row has room for a few words; the detail pane shows all of it. */
function firstLine(text: string | null): string | null {
  const line = text?.split("\n").find((l) => l.trim())?.trim();
  return line || null;
}

const SEND_WORDS: Readonly<Record<string, string>> = { succeeded: "Sent", failed: "Not sent", unknown: "Outcome unknown" };

/** What a job that succeeded produced, by kind; a kind with nothing worth naming is "Done". */
function successWords(job: JobView): string {
  const r = (job.result ?? {}) as Result;
  if (job.cancelOutcome === "too_late") return "Finished before the cancel";
  switch (job.kind) {
    case "research": {
      const cited = Array.isArray(r.citations) ? r.citations.length : 0;
      return r.supported === false || cited === 0 ? "No supporting evidence found" : `Answered from ${plural(cited, "source")}`;
    }
    case "briefing":
      return "Briefing written";
    case "draft":
      return typeof r.version === "number" ? `Draft v${r.version} ready` : "Draft ready";
    case "source-refresh": {
      const sources = Array.isArray(r.sources) ? (r.sources as Result[]) : [];
      const created = sources.reduce((n, s) => n + (typeof s.created === "number" ? s.created : 0), 0);
      return `Read ${plural(sources.length, "source")} · ${created ? plural(created, "new item") : "nothing new"}`;
    }
    case "reindex":
      return typeof r.indexed === "number" ? `Indexed ${plural(r.indexed, "file")}` : "Index rebuilt";
    case "action":
      return SEND_WORDS[String(r.status)] ?? (r.skipped ? "Nothing to send" : "Done");
    case "demo-long":
      return typeof r.completedSteps === "number" ? `${plural(r.completedSteps, "step")} done` : "Done";
    default:
      return "Done";
  }
}

const CANCEL_WORDS: Readonly<Record<string, string>> = { not_started: "Cancelled before it started", stopped: "Cancelled, stopped early" };

/** The whole reason a failed or blocked job gives, when it says more than the first line its row and state show. */
export function reasonBeyondSummary(job: JobView): string | null {
  if (!needsOwner(job) || !job.error) return null;
  const full = job.error.trim();
  return full === firstLine(full) ? null : full;
}

export function jobSummary(job: JobView): JobSummary {
  switch (job.status) {
    case "running":
      return { tag: null, words: [`${Math.round(job.progress * 100)}%`, job.progressNote].filter(Boolean).join(" · ") };
    case "queued": {
      const reason = job.attempts > 0 ? firstLine(job.error) : null;
      return { tag: null, words: reason ? `Trying again after: ${reason}` : "Waiting to start" };
    }
    case "failed":
      return { tag: "Failed", words: firstLine(job.error) ?? "No reason was recorded" };
    case "blocked":
      return { tag: "Blocked", words: firstLine(job.error) ?? "No reason was recorded" };
    case "cancelled":
      return { tag: null, words: CANCEL_WORDS[job.cancelOutcome ?? ""] ?? "Cancelled" };
    default:
      return { tag: null, words: successWords(job) };
  }
}

/** The time column: the instant in `iso`, its short form in `text`, and the whole of it in words in `label`. */
export interface JobTime {
  iso: string;
  text: string;
  label: string;
}

/** Which instant a row shows, and the word for it: when it was asked for, started, or finished. */
function rowInstant(job: JobView): { iso: string; word: string } {
  if (job.status === "queued") return { iso: job.createdAt, word: "Queued" };
  if (job.status === "running") return { iso: job.startedAt ?? job.createdAt, word: "Started" };
  if (job.finishedAt) return { iso: job.finishedAt, word: "Finished" };
  return { iso: job.updatedAt, word: "Ended" };
}

const shortDay = (at: number, timeZone: string) => new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" }).format(at);

/** "09:15" today, "Yesterday", or "2 Nov", so a column 13 px wide holds it; the label never leaves the day out. */
export function jobTime(job: JobView, now: number, timeZone: string): JobTime {
  const { iso, word } = rowInstant(job);
  const at = Date.parse(iso);
  const label = `${word} ${spokenTime(at, now, timeZone)}`;
  if (sameDay(at, now, timeZone)) return { iso, text: clockTime(at, timeZone), label };
  if (startOfDay(now, timeZone, -1) === startOfDay(at, timeZone)) return { iso, text: "Yesterday", label };
  return { iso, text: shortDay(at, timeZone), label };
}

/** An event's time: "09:15:02" today, so events a second apart read apart; "17 Nov" on another day. */
export function eventTime(iso: string, now: number, timeZone: string): string {
  const at = Date.parse(iso);
  if (!sameDay(at, now, timeZone)) return shortDay(at, timeZone);
  return `${clockTime(at, timeZone)}:${String(new Date(at).getUTCSeconds()).padStart(2, "0")}`;
}

/** What Cancel did, by the service's outcome. */
export const CANCEL_OUTCOME: Readonly<Record<NonNullable<JobView["cancelOutcome"]>, string>> = {
  stopped: "Stopped: the work ended before it finished.",
  too_late: "Already finished: the cancel came after the work was done, so its result stands.",
  not_started: "Cancelled before it started.",
};
const CANCEL_PENDING = "Cancel asked for. Waiting for the work to stop…";

/**
 * What the detail pane says about a cancel: its outcome once the service has settled it, "waiting" while running work
 * has been asked to stop, and nothing otherwise. The outcome comes from the job itself, so it is the same after a reload.
 */
export function cancelNote(job: JobView): string | null {
  if (job.cancelOutcome) return CANCEL_OUTCOME[job.cancelOutcome];
  if (job.cancelRequestedAt && (ACTIVE_STATUSES as readonly string[]).includes(job.status)) return CANCEL_PENDING;
  return null;
}

/** A job's kind in words: the small line over its title in the detail pane. */
export const JOB_KIND_WORDS: Readonly<Record<JobKind, string>> = {
  research: "Research",
  briefing: "Briefing",
  draft: "Draft",
  "source-refresh": "Source refresh",
  import: "Import",
  reindex: "Search index",
  action: "Sending",
  "demo-long": "Diagnostics",
  "session-distill": "Session notes",
  "session-consolidate": "Consolidation",
  "capture-consolidate": "Meeting capture",
};

/** One line of a job's events, in words. An event this screen does not know reads as its type. */
export function describeEvent(e: JobEvent): string {
  const d = e.data;
  switch (e.type) {
    case "progress":
      return [`${Math.round(Number(d.progress ?? 0) * 100)}%`, d.note ? String(d.note) : null].filter(Boolean).join(" · ");
    case "searched":
      return `Searched “${String(d.query)}”: ${plural(Number(d.hits), "hit")}`;
    case "source_synced":
      return `Refreshed ${String(d.id)}: ${String(d.coverage)}`;
    case "retry_scheduled":
      return `Failed (${String(d.error)}); trying again in ${Math.round(Number(d.inMs) / 1000)} s`;
    case "recovered":
      return String(d.note ?? "Recovered after a restart");
    case "failed":
      return `Failed: ${String(d.error)}`;
    case "blocked":
      return `Blocked: ${String(d.reason)}`;
    case "cancelled":
      return CANCEL_OUTCOME[String(d.outcome) as keyof typeof CANCEL_OUTCOME] ?? "Cancelled";
    case "queued":
      return "Queued";
    case "started":
      return Number(d.attempt) > 1 ? `Started attempt ${Number(d.attempt)}` : "Started";
    case "succeeded":
      return "Finished";
    case "retry_requested":
      return "Retry asked for";
    case "cancel_requested":
      return "Cancel asked for";
    case "cancel_too_late":
      return CANCEL_OUTCOME.too_late;
    case "effect_done":
      return "External effect recorded once";
    case "effect_reused":
    case "effect_recovered":
      return "Earlier effect found; not repeated";
    default: {
      const words = e.type.replace(/_/g, " ");
      return words.charAt(0).toUpperCase() + words.slice(1);
    }
  }
}
