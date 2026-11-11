import { z } from "zod";
import type { App } from "../app.ts";
import type { JobContext } from "../jobs/queue.ts";
import { chunkTurns, renderTurns } from "../agents/transcripts.ts";
import { complete } from "../models/providers.ts";
import type { ProposalOrigin } from "../memory/proposals.ts";
import { originSource } from "../memory/save.ts";
import { factDay } from "../memory/review-date.ts";
import type { SourceRef } from "../memory/store.ts";
import { CONSOLIDATION_MAX, consolidationPrompt, consolidationSystemPrompt } from "./prompt.ts";
import { pendingLine } from "./pending.ts";
import { parseConsolidationReply, type Candidate, type Dropped } from "./reply.ts";
import { relatedNotes } from "./related.ts";
import { screenCandidates } from "./screen.ts";

export const CONSOLIDATION_JOB = "session-consolidate";
/** Who Consolidation's Proposals are from, in the Dashboard and in the change log. */
export const CONSOLIDATED_BY = "Consolidation";
export const NO_MODEL_MESSAGE = "No model is connected, so Jarvis made no Proposals from this session.";

const MAX_INPUT_CHARS = 100_000;

/** Which turns of which session to read, and what the summary found durable in them (the search queries for related notes). */
const ConsolidationInput = z.object({
  agent: z.string().min(1),
  sessionId: z.string().min(1),
  from: z.number().int().min(0),
  to: z.number().int().min(1),
  topics: z.array(z.string()).max(20),
});
export type ConsolidationInput = z.infer<typeof ConsolidationInput>;

export type ConsolidationResult = { proposals: number; dropped: string[] } | { proposals: 0; skipped: string; message?: string };

/** Queue Consolidation of turns a summary just logged. Runs on this Machine, where the session ended. */
export function queueConsolidation(app: App, input: ConsolidationInput, session: { label: string; title: string }) {
  app.jobs.create({
    kind: CONSOLIDATION_JOB,
    title: `Consolidate ${session.label} session: ${session.title.slice(0, 60)}`,
    input,
    capability: "sessions",
    idempotencyKey: `${CONSOLIDATION_JOB}:${input.agent}:${input.sessionId}:${input.to}`,
  });
}

/**
 * Read a finished part of a Harness session and record at most five
 * Proposals from it. They always wait for the owner: Consolidation never
 * saves, whatever auto-accept says, because only the owner's click applies a
 * Proposal.
 */
export async function runConsolidation(app: App, ctx: JobContext): Promise<ConsolidationResult> {
  const input = ConsolidationInput.parse(ctx.input);
  const session = app.sessions.sessionPart(input.agent, input.sessionId, input.from, input.to);
  if (!session) return { proposals: 0, skipped: "session not found" };
  const model = await app.model();
  if (!model) {
    app.log.info(NO_MODEL_MESSAGE, { agent: input.agent, sessionId: input.sessionId });
    return { proposals: 0, skipped: "no model", message: NO_MODEL_MESSAGE };
  }
  const origin: ProposalOrigin = { agent: input.agent, sessionId: input.sessionId, ...(session.cwd ? { cwd: session.cwd } : {}) };
  const room = CONSOLIDATION_MAX - app.proposals.from(CONSOLIDATED_BY, origin).length;
  if (room <= 0) return { proposals: 0, skipped: `this session already has ${CONSOLIDATION_MAX} Proposals` };

  ctx.progress(0.1, "Finding related notes");
  const related = relatedNotes(app.db, app.memory, [...input.topics, session.title]);
  const pending = app.proposals.list({ status: "proposed", limit: 500 }).flatMap((p) => (p.item ? [p.item] : []));
  const names = { user: session.userName, assistant: session.agentLabel };
  // Long sessions are read in parts, like the summary, so an early decision is never skipped.
  const parts = chunkTurns(session.turns, MAX_INPUT_CHARS).map((part) => renderTurns(part, names, MAX_INPUT_CHARS));
  const candidates: Candidate[] = [];
  const dropped: Dropped[] = [];
  for (const [i, text] of parts.entries()) {
    ctx.progress(0.2 + (0.6 * i) / parts.length, parts.length > 1 ? `Reading part ${i + 1} of ${parts.length}` : "Reading the session");
    const reply = await complete(model, {
      system: consolidationSystemPrompt(session.userName, factDay()),
      messages: [{ role: "user", content: consolidationPrompt({ session: text, related, pending: pending.map(pendingLine) }) }],
      maxTokens: 2_000,
      signal: ctx.signal,
    });
    const parsed = parseConsolidationReply(reply);
    candidates.push(...parsed.candidates);
    dropped.push(...parsed.dropped);
  }

  const screened = screenCandidates(app.memory, candidates, { session: parts.join("\n\n"), pending, limit: room });
  const problems = [...dropped, ...screened.dropped].map((d) => d.problem);
  if (problems.length) app.log.info("Consolidation dropped model output", { agent: input.agent, sessionId: input.sessionId, dropped: problems });
  const ids = await ctx.effect(
    `consolidation:${input.agent}:${input.sessionId}:${input.to}`,
    async () => screened.accepted.map((c) => app.proposals.proposeItems([c.item], { reason: c.reason, source: citation(app, origin, c.evidence), origin, evidence: c.evidence, proposedBy: CONSOLIDATED_BY })[0]!.id),
    // After a crash mid-run, the Proposals this run already recorded stand; none is made twice.
    async (since) => {
      const made = app.proposals.from(CONSOLIDATED_BY, origin).filter((p) => p.createdAt >= since);
      return made.length ? made.map((p) => p.id) : null;
    },
  );
  if (ids.length) app.bus.emit("event", { type: "memory.changed" });
  return { proposals: ids.length, dropped: problems };
}

/** The session's archived transcript, down to the line that holds the quoted evidence when it fits on one. */
function citation(app: App, origin: ProposalOrigin, evidence: string): SourceRef | null {
  const source = originSource(app, origin);
  if (!source || !app.memory.exists(source.ref)) return source;
  const quote = evidence.replace(/\s+/g, " ").trim().toLowerCase();
  const line = app.memory
    .read(source.ref)
    .split("\n")
    .findIndex((l) => l.replace(/\s+/g, " ").toLowerCase().includes(quote));
  return line >= 0 ? { ...source, lines: [line + 1, line + 1] } : source;
}
