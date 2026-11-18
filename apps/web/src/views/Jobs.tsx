import { useEffect, useState } from "react";
import { plural, type JobEvent, type JobView } from "@attache/contracts";
import { post } from "../api.ts";
import { useLiveEvent, useResource } from "../live.ts";
import { Empty, ErrorState, Loading, Markdown, navigate, Time, useAction, useLocation } from "../components/ui.tsx";
import { StateTag } from "../components/StateTag.tsx";
import { useRevealDetail } from "../components/reveal-detail.ts";
import { useOpenEvidence } from "../components/Evidence.tsx";

const OUTCOME: Record<string, string> = {
  stopped: "Cancelled: the work stopped before finishing.",
  too_late: "The cancel request arrived after the job had already finished; its result stands.",
  not_started: "Cancelled before it started.",
};

function describe(e: JobEvent): string {
  const d = e.data as Record<string, unknown>;
  switch (e.type) {
    case "progress":
      return `${Math.round(Number(d.progress ?? 0) * 100)}%${d.note ? ` — ${String(d.note)}` : ""}`;
    case "searched":
      return `Searched “${String(d.query)}” — ${plural(Number(d.hits), "hit")}`;
    case "source_synced":
      return `Refreshed ${String(d.id)}: ${String(d.coverage)}`;
    case "retry_scheduled":
      return `Failed (${String(d.error)}); retrying in ${Math.round(Number(d.inMs) / 1000)}s`;
    case "recovered":
      return String(d.note ?? "Recovered after restart");
    case "failed":
      return `Failed: ${String(d.error)}`;
    case "cancelled":
      return OUTCOME[String(d.outcome)] ?? "Cancelled";
    case "effect_done":
      return "External effect recorded once";
    case "effect_reused":
    case "effect_recovered":
      return "Earlier effect found; not repeated";
    case "blocked":
      return `Blocked: ${String(d.reason)}`;
    default:
      return e.type.replace(/_/g, " ");
  }
}

function JobDetail({ id }: { id: string }) {
  const r = useResource<{ job: JobView; events: JobEvent[] }>(`/jobs/${id}`, []);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [job, setJob] = useState<JobView | null>(null);
  const [cancelMsg, setCancelMsg] = useState<string | null>(null);
  const { busy, run } = useAction();
  const open = useOpenEvidence();
  useEffect(() => {
    if (r.data) {
      setJob(r.data.job);
      setEvents(r.data.events);
    }
  }, [r.data]);
  useLiveEvent((ev) => {
    if (ev.type !== "job.event") return;
    const e = ev.event as JobEvent;
    if (e.jobId !== id) return;
    setEvents((xs) => (xs.some((x) => x.seq === e.seq) ? xs : [...xs, e]));
    if (["succeeded", "failed", "cancelled", "blocked", "started", "retry_scheduled", "recovered", "cancel_too_late"].includes(e.type)) r.reload();
    if (e.type === "progress") setJob((j) => (j ? { ...j, progress: Number(e.data.progress ?? j.progress), progressNote: String(e.data.note ?? j.progressNote ?? "") } : j));
  });
  if (r.loading && !job) return <Loading lines={6} />;
  if (r.error) return <ErrorState error={r.error} retry={r.reload} />;
  if (!job) return null;
  const active = ["queued", "running"].includes(job.status);
  const result = job.result as { relPath?: string; answer?: string; supported?: boolean; counts?: Record<string, number>; completedSteps?: number; actionId?: string; sources?: unknown[] } | null;
  return (
    <div className="stack" data-job-id={job.id} data-status={job.status}>
      <div className="row">
        <h2 className="detail-title" style={{ flex: 1 }}>{job.title}</h2>
        <StateTag state={job.status} />
      </div>
      <div className="progress" aria-label="Progress" aria-valuenow={Math.round(job.progress * 100)} role="progressbar">
        <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
      </div>
      <p className="small muted">
        {job.progressNote ?? ""} · attempt {job.attempts} of {job.maxAttempts} · created <Time iso={job.createdAt} />
        {job.finishedAt ? <> · finished <Time iso={job.finishedAt} /></> : null}
      </p>
      {job.error && job.status !== "succeeded" && <p className="small error-text">{job.error}</p>}
      {(cancelMsg || job.cancelOutcome) && <div className="state partial small">{cancelMsg ?? OUTCOME[job.cancelOutcome!]}</div>}
      <div className="row">
        {active && (
          <button
            disabled={busy !== null}
            onClick={() =>
              run("cancel", async () => {
                const out = await post<{ outcome: string }>(`/jobs/${job.id}/cancel`);
                setCancelMsg(out.outcome === "pending" ? "Cancel requested; waiting for the work to stop…" : (OUTCOME[out.outcome] ?? out.outcome));
                r.reload();
              })
            }
          >
            Cancel
          </button>
        )}
        {!active && job.status !== "succeeded" && (
          <button disabled={busy !== null} onClick={() => run("retry", () => post(`/jobs/${job.id}/retry`).then(() => { setCancelMsg(null); r.reload(); }), "Retrying")}>
            Retry
          </button>
        )}
        {!active && job.status === "succeeded" && (
          <button className="ghost" disabled={busy !== null} onClick={() => run("cancel", async () => { const out = await post<{ outcome: string }>(`/jobs/${job.id}/cancel`); setCancelMsg(OUTCOME[out.outcome] ?? out.outcome); })}>
            Cancel
          </button>
        )}
      </div>
      {job.status === "succeeded" && result && (
        <div className="card stack-sm">
          <h3>Result</h3>
          {result.answer && <Markdown text={result.answer} />}
          {result.supported === false && <div className="unsupported">No supporting evidence was found.</div>}
          {result.relPath && (
            <button className="small" style={{ alignSelf: "flex-start" }} onClick={() => open({ root: "data", relPath: result.relPath!, title: job.title })}>
              Open {result.relPath}
            </button>
          )}
          {result.actionId && (
            <button className="small" style={{ alignSelf: "flex-start" }} onClick={() => navigate(`/drafts?id=${result.actionId}`)}>
              Open the draft
            </button>
          )}
          {!result.answer && !result.relPath && !result.actionId && <pre className="mono small" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(result, null, 2)}</pre>}
        </div>
      )}
      <div className="card">
        <h3>Events</h3>
        <ol className="timeline" style={{ marginTop: 6 }} aria-label="Job events">
          {events.map((e) => (
            <li key={e.seq} data-event={e.type}>
              <Time iso={e.at} />
              <span>{describe(e)}</span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

export function JobsView() {
  const loc = useLocation();
  const list = useResource<JobView[]>("/jobs?limit=100", ["job"]);
  const [question, setQuestion] = useState("");
  const { busy, run } = useAction();
  const selected = loc.search.get("id");
  const { detailRef, revealDetail } = useRevealDetail();
  const create = (body: Record<string, unknown>) =>
    run("create", async () => {
      const r = await post<{ job: JobView }>("/jobs", body);
      navigate(`/jobs?id=${r.job.id}`);
      list.reload();
    });
  return (
    <div className="page">
      <div className="page-header">
        <h1>Jobs</h1>
        <span className="subtitle">Background work runs in the Attache service. Close this tab and it keeps going.</span>
      </div>
      <form
        className="card row research-form"
        onSubmit={(e) => {
          e.preventDefault();
          void create({ kind: "research", input: { question } }).then(() => setQuestion(""));
        }}
      >
        <label className="sr-only" htmlFor="research-q">
          Research question
        </label>
        <input id="research-q" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Research a question across your notes, e.g. What is still open on Atlas?" />
        <button className="primary" disabled={busy !== null || !question.trim()}>
          Research
        </button>
        <button type="button" className="ghost" title="A 2-minute diagnostic job for checking durability" onClick={() => void create({ kind: "demo-long", input: { steps: 60, stepMs: 2000 } })}>
          Diagnostics
        </button>
      </form>
      <div className="split">
        <div>
          {list.loading && !list.data && <Loading />}
          <ErrorState error={list.error} retry={list.reload} />
          {list.data?.length === 0 && <Empty title="No jobs yet">Research, briefing and draft jobs appear here with their progress and results.</Empty>}
          <div className="list">
            {list.data?.map((j) => (
              <button key={j.id} className="list-item" aria-current={j.id === selected} onClick={() => { navigate(`/jobs?id=${j.id}`); revealDetail(); }}>
                <div className="stack-sm" style={{ minWidth: 0, flex: 1 }}>
                  <strong style={{ overflowWrap: "anywhere" }}>{j.title}</strong>
                  <span className="row small muted">
                    <StateTag state={j.status} />
                    {j.status === "running" && `${Math.round(j.progress * 100)}%`} <Time iso={j.updatedAt} />
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
        <div ref={detailRef} className="split-detail">{selected ? <JobDetail key={selected} id={selected} /> : <Empty title="Select a job" />}</div>
      </div>
    </div>
  );
}
