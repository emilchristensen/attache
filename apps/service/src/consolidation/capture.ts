import { createHash } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import type { App } from "../app.ts";
import type { JobContext } from "../jobs/queue.ts";
import type { SourceRef } from "../memory/store.ts";
import { captureParts, inCapturesArea, isMeeting, quotedLines, readMeetingCapture, type MeetingCapture } from "./capture-text.ts";
import { CONSOLIDATED_BY, MAX_INPUT_CHARS, consolidate, type PipelineResult } from "./pipeline.ts";

export const CAPTURE_CONSOLIDATION_JOB = "capture-consolidate";

const CaptureConsolidationInput = z.object({ path: z.string().min(1).max(1000).refine(inCapturesArea, "not a capture") });

export type CaptureConsolidationResult = PipelineResult & { capture: string };

/** Queue Consolidation of a meeting capture that arrived on this Machine. Runs once per capture of a data folder. */
export function queueCaptureConsolidation(app: App, relPath: string) {
  app.jobs.create({
    kind: CAPTURE_CONSOLIDATION_JOB,
    title: `Consolidate meeting capture ${basename(relPath, ".md").slice(0, 80)}`,
    input: { path: relPath },
    capability: "capture",
    idempotencyKey: `${CAPTURE_CONSOLIDATION_JOB}:${folderKey(app)}:${relPath}`,
  });
}

/**
 * Read a meeting capture and record at most five Proposals from it, each
 * citing the capture and the lines its evidence is quoted from. It goes
 * through the same pipeline as a session, corrections included.
 */
export async function runCaptureConsolidation(app: App, ctx: JobContext): Promise<CaptureConsolidationResult> {
  const { path } = CaptureConsolidationInput.parse(ctx.input);
  if (!app.memory.dataRoot || !app.memory.exists(path)) return { capture: path, proposals: 0, skipped: "capture not found" };
  const raw = app.memory.read(path);
  if (!isMeeting(raw)) return { capture: path, proposals: 0, skipped: "not a meeting capture" };
  const capture = readMeetingCapture(raw, basename(path, ".md"));
  const result = await consolidate(app, ctx, {
    subject: "meeting",
    userName: app.config.get().identity?.name || "the owner",
    queries: capture.queries,
    parts: () => captureParts(capture.lines, MAX_INPUT_CHARS),
    made: () => app.proposals.citing(CONSOLIDATED_BY, "capture", path),
    cite: (evidence) => citation(app, path, capture, evidence),
    effectKey: `consolidation:capture:${folderKey(app)}:${path}`,
    logFields: { capture: path },
  });
  return { capture: path, ...result };
}

/** Which data folder a capture is in, so the same path in another folder is another capture. */
const folderKey = (app: App) => createHash("sha256").update(app.memory.dataRoot ?? "").digest("hex").slice(0, 12);

/** The capture, down to the lines that hold the quoted evidence. */
function citation(app: App, path: string, capture: MeetingCapture, evidence: string): SourceRef {
  const lines = quotedLines(capture.lines, evidence);
  return { kind: "capture", ref: path, observedAt: app.clock.now().toISOString(), label: capture.title.slice(0, 200), ...(lines ? { lines } : {}) };
}
