import { useEffect, useState, type ReactNode } from "react";
import { useMoveKeys } from "../shortcuts.ts";
import type { JobView } from "@attache/contracts";
import { post } from "../api.ts";
import { useResource, type Resource } from "../live.ts";
import { Loading, navigate, useAction, useLocation } from "../components/ui.tsx";
import { usePageRoom, useRevealDetail } from "../components/reveal-detail.ts";
import { useHeadsUpClock, type HeadsUpClock } from "../heads-up-clock.ts";
import { ACTIVE_STATUSES, ENDED_STATUSES, initialJobId, jobSummary, jobTime, runningOrder } from "../jobs.ts";
import { GroupFailure } from "../components/GroupFailure.tsx";
import { JobDetail, JobTag } from "./JobDetail.tsx";

/** How many ended jobs Finished shows at first, and how many more each "Show more" adds. */
const FINISHED_PAGE = 50;
/** The most the service lists in one answer. */
const FINISHED_MAX = 500;
/** More queued and running jobs than this at once would be a runaway; the list says so by its count. */
const RUNNING_LIMIT = 100;
/** A Diagnostics run: two minutes of checkpointed steps with one recorded side effect, for checking durability. */
const DIAGNOSTICS = { kind: "demo-long", input: { steps: 60, stepMs: 2000 } };

const jobsHref = (id: string) => `/jobs?id=${encodeURIComponent(id)}`;

/**
 * The detail the screen opens on, chosen once: when both lists and the newest failure have first answered (or
 * failed), from what they hold. The newest failure is asked for on its own, since it can be older than Finished's
 * first page. Live updates change the lists, never this choice; only the owner's pick (`?id=`) changes what the pane
 * shows.
 */
function useInitialJob(active: Resource<JobView[]>, ended: Resource<JobView[]>): string | null {
  const [chosen, setChosen] = useState<{ id: string | null } | null>(null);
  const failure = useResource<JobView[]>(chosen === null ? "/jobs?status=failed,blocked&limit=1" : null);
  const answered = (r: Resource<JobView[]>) => r.data !== null || r.error !== null;
  const ready = answered(active) && answered(ended) && answered(failure);
  useEffect(() => {
    if (chosen === null && ready) setChosen({ id: initialJobId(active.data ?? [], [...(ended.data ?? []), ...(failure.data ?? [])]) });
  }, [chosen, ready, active.data, ended.data, failure.data]);
  return chosen?.id ?? null;
}

/** The rows a resource last answered with, kept while a bigger page of them loads, so "Show more" does not blank the list. */
function useHeldRows(r: Resource<JobView[]>): JobView[] | null {
  const [held, setHeld] = useState<JobView[] | null>(null);
  if (r.data && r.data !== held) setHeld(r.data);
  return r.data ?? held;
}

/**
 * Jobs: background work the service runs, as a quiet table. Running holds queued and running work, Finished the rest,
 * newest first. The detail pane opens on the running job, else the newest failure, else the newest job, and keeps
 * whatever it shows until the owner picks another row.
 */
export function JobsView() {
  const loc = useLocation();
  useMoveKeys(".job-rows .job-pick");
  const picked = loc.search.get("id");
  const active = useResource<JobView[]>(`/jobs?status=${ACTIVE_STATUSES.join(",")}&limit=${RUNNING_LIMIT}`, ["job"]);
  const [finishedLimit, setFinishedLimit] = useState(FINISHED_PAGE);
  const ended = useResource<JobView[]>(`/jobs?status=${ENDED_STATUSES.join(",")}&limit=${finishedLimit}`, ["job"]);
  const endedRows = useHeldRows(ended);
  const initial = useInitialJob(active, ended);
  const selected = picked ?? initial;
  const clock = useHeadsUpClock();
  const { detailRef, revealDetail } = useRevealDetail();
  usePageRoom(detailRef);
  // Another job starts at the top of the pane.
  useEffect(() => {
    if (detailRef.current) detailRef.current.scrollTop = 0;
  }, [detailRef, selected]);
  const pick = (id: string) => {
    navigate(jobsHref(id));
    revealDetail();
  };
  const moreToShow = endedRows !== null && endedRows.length >= finishedLimit && finishedLimit < FINISHED_MAX;
  return (
    <div className="page">
      <div className="jobs">
        <div className="page-header">
          <h1>Jobs</h1>
          <span className="subtitle">Background work runs in the Attache service. Close this tab and it keeps going.</span>
        </div>
        <ResearchForm onCreated={pick} />
        <div className="split jobs-split">
          <div className="jobs-lists">
            <JobGroup id="jobs-running" title="Running" resource={active} rows={active.data ? runningOrder(active.data) : null} none="Nothing is running." selected={selected} clock={clock} onPick={pick} />
            <JobGroup id="jobs-finished" title="Finished" resource={ended} rows={endedRows} none="Nothing has finished yet. Research, briefings, Drafts and Source refreshes show here with what they produced." selected={selected} clock={clock} onPick={pick}>
              {moreToShow && (
                <button className="small jobs-more" disabled={ended.loading} onClick={() => setFinishedLimit((n) => Math.min(n + FINISHED_PAGE, FINISHED_MAX))}>
                  Show {FINISHED_PAGE} more
                </button>
              )}
              {endedRows !== null && endedRows.length >= FINISHED_MAX && <p className="jobs-none">These are the newest {FINISHED_MAX}; older jobs are kept but not listed here.</p>}
            </JobGroup>
          </div>
          <div ref={detailRef} className="split-detail jobs-detail sticky-detail">
            {selected ? <JobDetail key={selected} id={selected} /> : <p className="reader-placeholder">{endedRows?.length === 0 && active.data?.length === 0 ? "No jobs yet. Research a question above, or wait for the next Source refresh." : "Pick a job to see its progress, result and events here."}</p>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The question to research across the notes, and Diagnostics; either opens the job it starts. */
function ResearchForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [question, setQuestion] = useState("");
  const { busy, run } = useAction();
  const create = (body: Record<string, unknown>) =>
    run("create", async () => {
      const out = await post<{ job: JobView }>("/jobs", body);
      onCreated(out.job.id);
      return out.job;
    });
  return (
    <form
      className="research-form"
      onSubmit={(e) => {
        e.preventDefault();
        void create({ kind: "research", input: { question } }).then((job) => job && setQuestion(""));
      }}
    >
      <label className="sr-only" htmlFor="research-q">
        Research question
      </label>
      <input id="research-q" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Research a question across your notes" />
      <button className="primary" disabled={busy !== null || !question.trim()}>
        Research
      </button>
      <button type="button" title="A 2-minute diagnostic job for checking durability" disabled={busy !== null} onClick={() => void create(DIAGNOSTICS)}>
        Diagnostics
      </button>
    </form>
  );
}

interface JobGroupProps {
  id: string;
  title: string;
  resource: Resource<JobView[]>;
  rows: JobView[] | null;
  none: string;
  selected: string | null;
  clock: HeadsUpClock;
  onPick: (id: string) => void;
  children?: ReactNode;
}

/** A ruled group of job rows under its heading, with its own failure and empty line. */
function JobGroup({ id, title, resource, rows, none, selected, clock, onPick, children }: JobGroupProps) {
  return (
    <section className="jobs-group" aria-labelledby={id}>
      <h2 className="jobs-group-title" id={id}>
        {title}
      </h2>
      {resource.error && <GroupFailure what={title === "Running" ? "Running jobs" : "Finished jobs"} error={resource.error} answeredAt={resource.answeredAt} retry={resource.reload} retained={rows !== null} />}
      {rows === null && !resource.error && <Loading lines={2} label={`Loading ${title.toLowerCase()} jobs`} />}
      {rows !== null && rows.length > 0 && (
        <ul className="job-rows">
          {rows.map((job) => (
            <JobRow key={job.id} job={job} selected={job.id === selected} clock={clock} onPick={onPick} />
          ))}
        </ul>
      )}
      {rows !== null && rows.length === 0 && <p className="jobs-none">{none}</p>}
      {children}
    </section>
  );
}

/** One job: its title, its result in a few words (a tag only for a failure or a block), and a time in a narrow column. */
function JobRow({ job, selected, clock, onPick }: { job: JobView; selected: boolean; clock: HeadsUpClock; onPick: (id: string) => void }) {
  const { tag, words } = jobSummary(job);
  const time = jobTime(job, clock.now, clock.timeZone);
  return (
    <li className="job-row" data-job-row={job.id} data-status={job.status}>
      <button className="job-pick" aria-current={selected ? "true" : undefined} onClick={() => onPick(job.id)}>
        <span className="job-title">{job.title}</span>
        <span className="job-result">
          {tag && <JobTag tag={tag} />}
          <span className="job-words">{words}</span>
        </span>
        <time className="job-time" dateTime={time.iso} title={time.label}>
          {time.text}
        </time>
      </button>
    </li>
  );
}
