import { z } from "zod";
import type { App } from "../app.ts";
import type { JobContext } from "../jobs/queue.ts";
import { chunkTurns, renderTurns } from "../agents/transcripts.ts";
import type { ProposalOrigin } from "../memory/proposals.ts";
import { originSource } from "../memory/save.ts";
import type { SourceRef } from "../memory/store.ts";
import { quotedLines } from "./capture-text.ts";
import { CONSOLIDATED_BY, MAX_INPUT_CHARS, consolidate, type PipelineResult } from "./pipeline.ts";

export const CONSOLIDATION_JOB = "session-consolidate";

/** Which turns of which session to read, and what the summary found durable in them (the search queries for related notes). */
const ConsolidationInput = z.object({
  agent: z.string().min(1),
  sessionId: z.string().min(1),
  from: z.number().int().min(0),
  to: z.number().int().min(1),
  topics: z.array(z.string()).max(20),
});
export type ConsolidationInput = z.infer<typeof ConsolidationInput>;

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

/** Read a finished part of a Harness session and record at most five Proposals from it. */
export async function runConsolidation(app: App, ctx: JobContext): Promise<PipelineResult> {
  const input = ConsolidationInput.parse(ctx.input);
  const session = app.sessions.sessionPart(input.agent, input.sessionId, input.from, input.to);
  if (!session) return { proposals: 0, skipped: "session not found" };
  const origin: ProposalOrigin = { agent: input.agent, sessionId: input.sessionId, ...(session.cwd ? { cwd: session.cwd } : {}) };
  const names = { user: session.userName, assistant: session.agentLabel };
  return consolidate(app, ctx, {
    subject: "session",
    userName: session.userName,
    queries: [...input.topics, session.title],
    parts: () => chunkTurns(session.turns, MAX_INPUT_CHARS).map((part) => renderTurns(part, names, MAX_INPUT_CHARS)),
    made: () => app.proposals.from(CONSOLIDATED_BY, origin),
    cite: (evidence) => citation(app, origin, evidence),
    origin,
    effectKey: `consolidation:${input.agent}:${input.sessionId}:${input.to}`,
    logFields: { agent: input.agent, sessionId: input.sessionId },
  });
}

/** The session's archived transcript, down to the lines that hold the quoted evidence. */
function citation(app: App, origin: ProposalOrigin, evidence: string): SourceRef | null {
  const source = originSource(app, origin);
  if (!source || !app.memory.exists(source.ref)) return source;
  const lines = app.memory
    .read(source.ref)
    .split("\n")
    .map((text, i) => ({ text, line: i + 1 }));
  const quoted = quotedLines(lines, evidence);
  return quoted ? { ...source, lines: quoted } : source;
}
