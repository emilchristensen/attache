import { useCallback, useRef } from "react";
import type { BriefingView, JobView } from "@attache/contracts";
import { post } from "../api.ts";
import { useLiveEvent, useResource } from "../live.ts";
import { useToast } from "../components/ui.tsx";

const ENDED = new Set(["succeeded", "failed", "cancelled", "blocked"]);

/** What a briefing asked for here is: today's Daily Briefing when there is none yet, a briefing asked for, or an away summary. */
export type BriefingKind = BriefingView["kind"];

/** A briefing job queued or running on this Machine. */
export interface BriefingJob {
  id: string;
  progress: number;
  note: string | null;
}

/**
 * The briefing being written on this Machine, scheduled or asked for, and a way to ask for one. A briefing asked for
 * here that fails says so in a notification; the Jobs screen keeps the details.
 */
export function useBriefingJob(enabled: boolean): { job: BriefingJob | null; start: (kind: BriefingKind, since?: string) => Promise<void> } {
  const jobs = useResource<JobView[]>(enabled ? "/jobs?status=queued,running&limit=50" : null, ["job"]);
  const mine = useRef(new Set<string>());
  const toast = useToast();
  useLiveEvent((ev) => {
    if (ev.type !== "job.event") return;
    const e = ev.event as { jobId: string; type: string; data: { error?: string } };
    if (!mine.current.has(e.jobId) || !ENDED.has(e.type)) return;
    mine.current.delete(e.jobId);
    if (e.type === "failed" || e.type === "blocked") toast(`The briefing could not be written${e.data.error ? `: ${e.data.error}` : "."} The Jobs screen has the details.`, "error");
  });
  const { reload } = jobs;
  const start = useCallback(
    async (kind: BriefingKind, since?: string) => {
      const r = await post<{ job: JobView }>("/briefings", { kind, ...(since ? { since } : {}) });
      mine.current.add(r.job.id);
      reload();
    },
    [reload],
  );
  const running = (jobs.data ?? []).filter((j) => j.kind === "briefing" && !ENDED.has(j.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return { job: running ? { id: running.id, progress: running.progress, note: running.progressNote } : null, start };
}
