import type { ProposalView } from "@attache/contracts";
import type { App } from "../app.ts";
import type { JobContext } from "../jobs/queue.ts";
import { complete } from "../models/providers.ts";
import type { ProposalOrigin } from "../memory/proposals.ts";
import { factDay } from "../memory/review-date.ts";
import type { SourceRef } from "../memory/store.ts";
import { pendingLine } from "./pending.ts";
import { CONSOLIDATION_MAX, consolidationPrompt, consolidationSystemPrompt } from "./prompt.ts";
import { parseConsolidationReply, type Candidate, type Dropped } from "./reply.ts";
import { relatedNotes } from "./related.ts";
import { screenCandidates } from "./screen.ts";
import { SUBJECTS, type ConsolidationSubject } from "./subjects.ts";

/** Who Consolidation's Proposals are from, in the Dashboard and in the change log. */
export const CONSOLIDATED_BY = "Consolidation";
/** The most text one model call reads; longer input is read in parts, so an early decision is never skipped. */
export const MAX_INPUT_CHARS = 100_000;

/** One thing Consolidation reads, and what differs between a session and a meeting capture. */
export interface ConsolidationSource {
  subject: ConsolidationSubject;
  userName: string;
  /** Search queries for the related notes the model is shown. */
  queries: readonly string[];
  /** The text to read, in parts of at most MAX_INPUT_CHARS that each go to one model call. */
  parts(): readonly string[];
  /** Consolidation's Proposals from this source so far: the five-per-source cap, and recovery after a crash. */
  made(): readonly ProposalView[];
  /** Where a Proposal quoting `evidence` cites. */
  cite(evidence: string): SourceRef | null;
  /** The Harness session a Proposal comes from, when it comes from one. */
  origin?: ProposalOrigin;
  /** Persisted key of the run's Proposal writes, so a retried run never makes them twice. */
  effectKey: string;
  /** Log fields that name the source. */
  logFields: Record<string, unknown>;
}

export type PipelineResult = { proposals: number; dropped: string[] } | { proposals: 0; skipped: string; message?: string };

/**
 * Read one source and record at most five Proposals from it, each citing the
 * passage it rests on. They always wait for the owner: Consolidation never
 * saves, whatever auto-accept says, because only the owner's click applies a
 * Proposal. Corrections of current facts, and the screening of repeats and
 * mentions, happen here for every subject alike.
 */
export async function consolidate(app: App, ctx: JobContext, source: ConsolidationSource): Promise<PipelineResult> {
  const { subject } = source;
  const wording = SUBJECTS[subject];
  const model = await app.model();
  if (!model) {
    app.log.info(wording.noModel, source.logFields);
    return { proposals: 0, skipped: "no model", message: wording.noModel };
  }
  const room = CONSOLIDATION_MAX - source.made().length;
  if (room <= 0) return { proposals: 0, skipped: `this ${wording.source} already has ${CONSOLIDATION_MAX} Proposals` };

  ctx.progress(0.1, "Finding related notes");
  const related = relatedNotes(app.db, app.memory, source.queries);
  const pending = app.proposals.list({ status: "proposed", limit: 500 }).flatMap((p) => (p.item ? [p.item] : []));
  const parts = source.parts();
  const candidates: Candidate[] = [];
  const dropped: Dropped[] = [];
  for (const [i, text] of parts.entries()) {
    ctx.progress(0.2 + (0.6 * i) / parts.length, parts.length > 1 ? `Reading part ${i + 1} of ${parts.length}` : wording.reading);
    const reply = await complete(model, {
      system: consolidationSystemPrompt(source.userName, factDay(), subject),
      messages: [{ role: "user", content: consolidationPrompt({ text, related, pending: pending.map(pendingLine), subject }) }],
      maxTokens: 2_000,
      signal: ctx.signal,
    });
    const parsed = parseConsolidationReply(reply);
    candidates.push(...parsed.candidates);
    dropped.push(...parsed.dropped);
  }

  const screened = screenCandidates(app.memory, candidates, { text: parts.join("\n\n"), noun: wording.noun, pending, limit: room });
  const problems = [...dropped, ...screened.dropped].map((d) => d.problem);
  if (problems.length) app.log.info("Consolidation dropped model output", { ...source.logFields, dropped: problems });
  const ids = await ctx.effect(
    source.effectKey,
    async () =>
      screened.accepted.map(
        (c) =>
          app.proposals.proposeItems([c.item], {
            reason: c.reason,
            source: source.cite(c.evidence),
            ...(source.origin ? { origin: source.origin } : {}),
            evidence: c.evidence,
            proposedBy: CONSOLIDATED_BY,
          })[0]!.id,
      ),
    // After a crash mid-run, the Proposals this run already recorded stand; none is made twice.
    async (since) => {
      const made = source.made().filter((p) => p.createdAt >= since);
      return made.length ? made.map((p) => p.id) : null;
    },
  );
  if (ids.length) app.bus.emit("event", { type: "memory.changed" });
  return { proposals: ids.length, dropped: problems };
}
