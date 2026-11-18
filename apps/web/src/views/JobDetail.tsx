import { useEffect, useState } from "react";
import type { JobEvent, JobView } from "@attache/contracts";
import { post } from "../api.ts";
import { useLiveEvent, useResource } from "../live.ts";
import { ErrorState, Loading, Markdown, navigate, useAction } from "../components/ui.tsx";
import { Tag } from "../components/Tag.tsx";
import { useOpenEvidence } from "../components/Evidence.tsx";
import { useHeadsUpClock } from "../heads-up-clock.ts";
import { spokenTime } from "../zoned-time.ts";
import { draftHref } from "../routes.ts";
import { ACTIVE_STATUSES, cancelNote, describeEvent, eventTime, JOB_KIND_WORDS, jobSummary, reasonBeyondSummary, type JobSummary } from "../jobs.ts";

/** Job events after which the job itself has changed, so the detail asks for it again. */
const CHANGING_EVENTS = new Set(["started", "succeeded", "failed", "cancelled", "blocked", "retry_scheduled", "recovered", "cancel_too_late", "cancel_requested", "retry_requested"]);

type JobResult = { relPath?: string; answer?: string; supported?: boolean; actionId?: string } | null;

const isActive = (job: JobView) => (ACTIVE_STATUSES as readonly string[]).includes(job.status);

/** One job in full: what it is, how far it got or what it produced, why it failed, Cancel or Retry, and its events. */
export function JobDetail({ id }: { id: string }) {
  const r = useResource<{ job: JobView; events: JobEvent[] }>(`/jobs/${id}`, []);
  const [job, setJob] = useState<JobView | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  // This tab's Cancel answer, for the cancel request it answered (another tab may retry and cancel again later).
  const [answer, setAnswer] = useState<{ outcome: string; requestedAt: string | null } | null>(null);
  const { busy, run } = useAction();
  useEffect(() => {
    if (!r.data) return;
    setJob(r.data.job);
    setEvents(r.data.events);
  }, [r.data]);
  useLiveEvent((ev) => {
    if (ev.type !== "job.event") return;
    const e = ev.event as JobEvent;
    if (e.jobId !== id) return;
    setEvents((xs) => (xs.some((x) => x.seq === e.seq) ? xs : [...xs, e]));
    if (CHANGING_EVENTS.has(e.type)) r.reload();
    if (e.type === "progress") setJob((j) => (j ? { ...j, progress: Number(e.data.progress ?? j.progress), progressNote: e.data.note ? String(e.data.note) : j.progressNote } : j));
  });
  if (r.loading && !job) return <Loading lines={6} label="Loading the job" />;
  if (r.error && !job) return <ErrorState error={r.error} retry={r.reload} />;
  if (!job) return null;

  const cancel = () =>
    run("cancel", async () => {
      // The answer carries the job as the service left it: its outcome, or the request still waiting for the work to stop.
      const out = await post<{ job: JobView; outcome: string }>(`/jobs/${job.id}/cancel`);
      setJob(out.job);
      setAnswer({ outcome: out.outcome, requestedAt: out.job.cancelRequestedAt });
      r.reload();
    });
  const retry = () =>
    run(
      "retry",
      async () => {
        const out = await post<{ job: JobView }>(`/jobs/${job.id}/retry`);
        setJob(out.job);
        setAnswer(null);
        r.reload();
      },
      "Retrying",
    );
  const note = cancelNote(job, answer && answer.requestedAt === job.cancelRequestedAt ? answer.outcome : undefined);
  // The state line shows the reason's first line; the whole of it only when there is more.
  const reason = reasonBeyondSummary(job);
  const stopping = isActive(job) && job.cancelRequestedAt !== null;
  return (
    <article className="job-detail" data-job-id={job.id} data-status={job.status} aria-labelledby={`job-title-${job.id}`}>
      <p className="reader-kind">{JOB_KIND_WORDS[job.kind] ?? job.kind}</p>
      <h2 className="detail-title" id={`job-title-${job.id}`}>
        {job.title}
      </h2>
      <JobState job={job} />
      {r.error && <ErrorState error={r.error} retry={r.reload} title="This job could not be refreshed. What shows here may be out of date." />}
      {isActive(job) && (
        <div className="progress job-progress" role="progressbar" aria-label="Progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress * 100)}>
          <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
        </div>
      )}
      <JobTimes job={job} />
      <p className="job-cancel-note" role="status">
        {note ?? ""}
      </p>
      <div className="job-actions">
        {isActive(job) && (
          <button disabled={busy !== null || stopping} onClick={() => void cancel()}>
            Cancel
          </button>
        )}
        {!isActive(job) && job.status !== "succeeded" && job.kind !== "action" && (
          <button disabled={busy !== null} onClick={() => void retry()}>
            Retry
          </button>
        )}
      </div>
      {reason && (
        <section className="job-section" aria-labelledby={`job-why-${job.id}`}>
          <h3 className="reader-rule" id={`job-why-${job.id}`}>
            {job.status === "failed" ? "Why it failed" : "Why it is blocked"}
          </h3>
          <p className="job-error">{reason}</p>
        </section>
      )}
      {job.status === "succeeded" && job.result !== null && <JobResultPart job={job} />}
      <JobEvents events={events} />
    </article>
  );
}

/** A failure in red, a block in amber (the owner can often fix it); a success never gets a tag. */
export function JobTag({ tag }: { tag: NonNullable<JobSummary["tag"]> }) {
  return tag === "Failed" ? <Tag tone="danger">{tag}</Tag> : <Tag hue="amber">{tag}</Tag>;
}

/** The state under the title: the row's words again, with the tag of a failure or a block; a success stays plain. */
function JobState({ job }: { job: JobView }) {
  const { tag, words } = jobSummary(job);
  return (
    <p className={`job-state${tag ? "" : " quiet"}`}>
      {tag && <JobTag tag={tag} />}
      <span>{words}</span>
    </p>
  );
}

/** When it was asked for, started and finished, and which attempt this is, in words that never leave the day out. */
function JobTimes({ job }: { job: JobView }) {
  const { now, timeZone } = useHeadsUpClock();
  const at = (iso: string) => spokenTime(Date.parse(iso), now, timeZone);
  const parts = [`Queued ${at(job.createdAt)}`, job.startedAt ? `started ${at(job.startedAt)}` : null, job.finishedAt ? `finished ${at(job.finishedAt)}` : null, job.attempts > 1 || isActive(job) ? `attempt ${Math.max(job.attempts, 1)} of ${job.maxAttempts}` : null];
  return <p className="job-times">{parts.filter(Boolean).join(" · ")}</p>;
}

/** What a succeeded job produced: the research answer, the file it wrote, the Draft it prepared. */
function JobResultPart({ job }: { job: JobView }) {
  const open = useOpenEvidence();
  const result = job.result as JobResult;
  if (!result) return null;
  const known = result.answer || result.relPath || result.actionId;
  return (
    <section className="job-section" aria-labelledby={`job-result-${job.id}`}>
      <h3 className="reader-rule" id={`job-result-${job.id}`}>
        Result
      </h3>
      {result.answer && <Markdown text={result.answer} />}
      {result.supported === false && <p className="unsupported">No supporting evidence was found.</p>}
      {(result.relPath || result.actionId) && (
        <div className="job-actions">
          {result.relPath && (
            <button className="small" onClick={() => open({ root: "data", relPath: result.relPath!, title: job.title })}>
              Open {result.relPath}
            </button>
          )}
          {result.actionId && (
            <button className="small" onClick={() => navigate(draftHref(String(result.actionId)))}>
              Open the draft
            </button>
          )}
        </div>
      )}
      {!known && <pre className="job-raw">{JSON.stringify(result, null, 2)}</pre>}
    </section>
  );
}

/** Everything the service recorded about the job, oldest first. */
function JobEvents({ events }: { events: readonly JobEvent[] }) {
  const { now, timeZone } = useHeadsUpClock();
  return (
    <section className="job-section" aria-labelledby="job-events">
      <h3 className="reader-rule" id="job-events">
        Events
      </h3>
      <ol className="timeline job-events" aria-label="Job events">
        {events.map((e) => (
          <li key={e.seq} data-event={e.type}>
            <time dateTime={e.at} title={new Date(e.at).toLocaleString()}>
              {eventTime(e.at, now, timeZone)}
            </time>
            <span>{describeEvent(e)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
