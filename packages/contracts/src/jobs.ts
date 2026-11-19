import { z } from "zod";

/** API contract: Jobs. */

export const JobKind = z.enum(["research", "briefing", "draft", "source-refresh", "import", "reindex", "action", "demo-long", "session-distill", "session-consolidate", "capture-consolidate"]);
export type JobKind = z.infer<typeof JobKind>;

/**
 * The live event a Source refresh sends when it starts and when it finishes (`{type, phase}`), so a client can tell
 * what the refresh changed: the Dashboard announces the decision count only when a Source refresh changed it. The
 * finish comes before the refresh's last `attention.changed`, so anything asked again on that event is asked after it.
 */
export const SOURCE_REFRESH_EVENT = "source-refresh";
export type SourceRefreshPhase = "started" | "finished";

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "blocked";

export interface JobView {
  id: string;
  kind: JobKind;
  title: string;
  status: JobStatus;
  progress: number;
  progressNote: string | null;
  attempts: number;
  maxAttempts: number;
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  cancelOutcome: "stopped" | "too_late" | "not_started" | null;
  capability: string | null;
  connectionId: string | null;
}

export interface JobEvent {
  seq: number;
  jobId: string;
  type: string;
  data: Record<string, unknown>;
  at: string;
}

export const JobCreateInput = z.object({
  kind: z.enum(["research", "briefing", "draft", "source-refresh", "import", "reindex", "demo-long"]),
  title: z.string().max(200).optional(),
  input: z.record(z.string(), z.unknown()).default({}),
  idempotencyKey: z.string().max(200).optional(),
});
