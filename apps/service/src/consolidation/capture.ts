import { createHash } from "node:crypto";
import { basename } from "node:path";
import { z } from "zod";
import type { App } from "../app.ts";
import type { JobContext } from "../jobs/queue.ts";
import { complete } from "../models/providers.ts";
import { factDay } from "../memory/review-date.ts";
import type { SourceRef } from "../memory/store.ts";
import { CONSOLIDATED_BY } from "./consolidate.ts";
import { captureParts, inCapturesArea, isMeeting, quotedLines, readMeetingCapture, type MeetingCapture } from "./capture-text.ts";
import { pendingLine } from "./pending.ts";
import { CONSOLIDATION_MAX, consolidationPrompt, consolidationSystemPrompt } from "./prompt.ts";
import { parseConsolidationReply, type Candidate, type Dropped } from "./reply.ts";
import { relatedNotes } from "./related.ts";
import { screenCandidates } from "./screen.ts";

export const CAPTURE_CONSOLIDATION_JOB = "capture-consolidate";
export const NO_MODEL_CAPTURE_MESSAGE = "No model is connected, so Jarvis made no Proposals from this meeting capture.";

const MAX_INPUT_CHARS = 100_000;

const CaptureConsolidationInput = z.object({ path: z.string().min(1).max(1000).refine(inCapturesArea, "not a capture") });

export type CaptureConsolidationResult = { capture: string; proposals: number; dropped: string[] } | { capture: string; proposals: 0; skipped: string; message?: string };

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
 * citing the capture and the lines its evidence is quoted from. Like a
 * session's, they always wait for the owner's click.
 */
export async function runCaptureConsolidation(app: App, ctx: JobContext): Promise<CaptureConsolidationResult> {
  const { path } = CaptureConsolidationInput.parse(ctx.input);
  if (!app.memory.dataRoot || !app.memory.exists(path)) return { capture: path, proposals: 0, skipped: "capture not found" };
  const raw = app.memory.read(path);
  if (!isMeeting(raw)) return { capture: path, proposals: 0, skipped: "not a meeting capture" };
  const model = await app.model();
  if (!model) {
    app.log.info(NO_MODEL_CAPTURE_MESSAGE, { capture: path });
    return { capture: path, proposals: 0, skipped: "no model", message: NO_MODEL_CAPTURE_MESSAGE };
  }
  const made = () => app.proposals.citing(CONSOLIDATED_BY, "capture", path);
  const room = CONSOLIDATION_MAX - made().length;
  if (room <= 0) return { capture: path, proposals: 0, skipped: `this capture already has ${CONSOLIDATION_MAX} Proposals` };

  const capture = readMeetingCapture(raw, basename(path, ".md"));
  ctx.progress(0.1, "Finding related notes");
  const related = relatedNotes(app.db, app.memory, capture.queries);
  const pending = app.proposals.list({ status: "proposed", limit: 500 }).flatMap((p) => (p.item ? [p.item] : []));
  const userName = app.config.get().identity?.name || "the owner";
  const parts = captureParts(capture.lines, MAX_INPUT_CHARS);
  const candidates: Candidate[] = [];
  const dropped: Dropped[] = [];
  for (const [i, text] of parts.entries()) {
    ctx.progress(0.2 + (0.6 * i) / parts.length, parts.length > 1 ? `Reading part ${i + 1} of ${parts.length}` : "Reading the meeting");
    const reply = await complete(model, {
      system: consolidationSystemPrompt(userName, factDay(), "meeting"),
      messages: [{ role: "user", content: consolidationPrompt({ session: text, related, pending: pending.map(pendingLine), subject: "meeting" }) }],
      maxTokens: 2_000,
      signal: ctx.signal,
    });
    const parsed = parseConsolidationReply(reply);
    candidates.push(...parsed.candidates);
    dropped.push(...parsed.dropped);
  }

  const screened = screenCandidates(app.memory, candidates, { session: parts.join("\n\n"), pending, limit: room });
  const problems = [...dropped, ...screened.dropped].map((d) => d.problem);
  if (problems.length) app.log.info("Consolidation dropped model output", { capture: path, dropped: problems });
  const ids = await ctx.effect(
    `consolidation:capture:${folderKey(app)}:${path}`,
    async () => screened.accepted.map((c) => app.proposals.proposeItems([c.item], { reason: c.reason, source: citation(app, path, capture, c.evidence), evidence: c.evidence, proposedBy: CONSOLIDATED_BY })[0]!.id),
    // After a crash mid-run, the Proposals this run already recorded stand; none is made twice.
    async (since) => {
      const again = made().filter((p) => p.createdAt >= since);
      return again.length ? again.map((p) => p.id) : null;
    },
  );
  if (ids.length) app.bus.emit("event", { type: "memory.changed" });
  return { capture: path, proposals: ids.length, dropped: problems };
}

/** Which data folder a capture is in, so the same path in another folder is another capture. */
const folderKey = (app: App) => createHash("sha256").update(app.memory.dataRoot ?? "").digest("hex").slice(0, 12);

/** The capture, down to the lines that hold the quoted evidence. */
function citation(app: App, path: string, capture: MeetingCapture, evidence: string): SourceRef {
  const lines = quotedLines(capture.lines, evidence);
  return { kind: "capture", ref: path, observedAt: app.clock.now().toISOString(), label: capture.title.slice(0, 200), ...(lines ? { lines } : {}) };
}
