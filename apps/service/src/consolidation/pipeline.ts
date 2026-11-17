import { randomUUID } from "node:crypto";
import type { MemorySaveItem } from "@attache/contracts";
import type { App } from "../app.ts";
import type { JobContext } from "../jobs/queue.ts";
import { complete } from "../models/providers.ts";
import type { ConsolidationFrom } from "../memory/change-log.ts";
import type { ProposalOrigin } from "../memory/proposals.ts";
import { factDay } from "../memory/review-date.ts";
import type { SourceRef } from "../memory/store.ts";
import { pendingLine } from "./pending.ts";
import { consolidationPrompt, consolidationSystemPrompt } from "./prompt.ts";
import { parseConsolidationReply, type Candidate } from "./reply.ts";
import { relatedNotes } from "./related.ts";
import { checkCandidates, oneValuePerFact, screenCandidates } from "./screen.ts";
import { SUBJECTS, type ConsolidationSubject } from "./subjects.ts";
import { writeCandidates, type WriteRecord } from "./write.ts";

/** Who Consolidation's Proposals are from, in the Dashboard and in the change log. */
export const CONSOLIDATED_BY = "Consolidation";
/** The most text one model call reads; longer input is read in parts, so an early decision is never skipped. */
export const MAX_INPUT_CHARS = 100_000;
/**
 * Room for the model's reply: with no cap on the changes one source yields, a long list must fit.
 * A reply that still reaches it keeps every change written out in full before the cut.
 */
const REPLY_MAX_TOKENS = 8_000;

/** One thing Consolidation reads, and what differs between a session and a meeting capture. */
export interface ConsolidationSource {
  subject: ConsolidationSubject;
  userName: string;
  /** Search queries for the related notes the model is shown. */
  queries: readonly string[];
  /** The text to read, in parts of at most MAX_INPUT_CHARS that each go to one model call. */
  parts(): readonly string[];
  /** Where this source's changes came from, as the change log records it. */
  from: ConsolidationFrom;
  /** Where a Proposal quoting `evidence` cites. */
  cite(evidence: string): SourceRef | null;
  /** The Harness session a Proposal comes from, when it comes from one. */
  origin?: ProposalOrigin;
  /**
   * Persisted key of the run's work, so a retried run never makes it twice.
   * Writing and proposing each add their own suffix: the switch may change
   * between a finished attempt and a retry, and each stores its own result.
   */
  effectKey: string;
  /** Log fields that name the source. */
  logFields: Record<string, unknown>;
}

/** What a run did: changes written to the Brain, or Proposals made, and what it dropped; or why it read nothing. */
export type PipelineResult = { written: number; proposals: number; dropped: string[] } | Skipped;
export type Skipped = { written: 0; proposals: 0; skipped: string; message?: string };

export const skipped = (reason: string, message?: string): Skipped => ({ written: 0, proposals: 0, skipped: reason, ...(message ? { message } : {}) });

/**
 * Read one source and turn what it finds into changes, each citing the
 * passage it rests on, with no limit on how many. With the Consolidation
 * switch on (the default, ADR 0004) each change is written to the Brain
 * straight away and marked as written without review, so it can be reverted
 * like any save; off, each becomes a Proposal that waits for the owner.
 * Corrections of current facts, and the screening of repeats and mentions,
 * happen here for every subject and both ways alike.
 * The model reads the source once per run: its answer is kept in the job's
 * checkpoint, so an attempt tried again works from the same answer and never
 * writes a second, different value over its own first write.
 */
export async function consolidate(app: App, ctx: JobContext, source: ConsolidationSource): Promise<PipelineResult> {
  const wording = SUBJECTS[source.subject];
  const pending = app.proposals.list({ status: "proposed", limit: 500 }).flatMap((p) => (p.item ? [p.item] : []));
  const reading = runSoFar(ctx).reading ?? (await read(app, ctx, source, pending));
  if ("skipped" in reading) return reading;

  // Read the switch again: the owner may have turned it off while the model was reading.
  const autoAccept = app.config.get().consolidation.autoAccept;
  const candidates = reading.candidates.map((c, index) => ({ ...c, index }));
  // What an earlier attempt of this run wrote or proposed passed every check then; it is done, not a change to drop now.
  const done = new Set([...ownWrites(app, ctx), ...ownProposals(app, ctx)].map((n) => n.candidate));
  // First the checks on each change by itself, so a change that fails them never pushes out one that passes.
  const failed = runSoFar(ctx).failed ?? checkOnce(app, ctx, source, candidates);
  const refused = new Set(failed.map((f) => f.candidate));
  const contenders = candidates.filter((c) => !refused.has(c.index));
  // A Proposal leaves the choice between two values of a fact to the owner; a write must make it.
  const chosen = autoAccept ? oneValuePerFact(contenders, wording.noun) : { kept: contenders, dropped: [] };
  // A Proposal an attempt made with the switch off can lose the choice a later attempt makes with it on; it is still done, not dropped.
  const lost = chosen.dropped.filter((d) => !done.has(d.candidate.index));
  const left = chosen.kept.filter((c) => !done.has(c.index));
  const screened = screenCandidates(app.memory, left, { pending });
  const late = autoAccept ? await write(app, ctx, source, screened.accepted) : await propose(app, ctx, source, screened.accepted);
  // The result counts what every attempt of this run did, whichever way the switch stood in each.
  const written = ownWrites(app, ctx).length;
  const proposals = ownProposals(app, ctx).length;
  const problems = [...reading.dropped, ...failed.map((f) => f.problem), ...[...lost, ...screened.dropped].map((d) => d.problem), ...late];
  if (problems.length) app.log.info("Consolidation dropped model output", { ...source.logFields, dropped: problems });
  if (written || proposals) app.bus.emit("event", { type: "memory.changed" });
  return { written, proposals, dropped: problems };
}

/**
 * Ask the model what the source holds, part by part, and keep its answer in the
 * job's checkpoint before anything is written. Each candidate keeps the part it
 * came from, so a later part's value of a fact wins.
 */
async function read(app: App, ctx: JobContext, source: ConsolidationSource, pending: readonly MemorySaveItem[]): Promise<Reading | Skipped> {
  const { subject } = source;
  const wording = SUBJECTS[subject];
  const model = await app.model();
  if (!model) {
    app.log.info(wording.noModel, source.logFields);
    return skipped("no model", wording.noModel);
  }
  // What the model is told; whether the run writes is decided once it has answered.
  const promptWrites = app.config.get().consolidation.autoAccept;
  ctx.progress(0.1, "Finding related notes");
  const related = relatedNotes(app.db, app.memory, source.queries);
  const parts = source.parts();
  const reading: Reading = { candidates: [], dropped: [] };
  for (const [i, text] of parts.entries()) {
    ctx.progress(0.2 + (0.6 * i) / parts.length, parts.length > 1 ? `Reading part ${i + 1} of ${parts.length}` : wording.reading);
    const reply = await complete(model, {
      system: consolidationSystemPrompt(source.userName, factDay(), subject, promptWrites),
      messages: [{ role: "user", content: consolidationPrompt({ text, related, pending: pending.map(pendingLine), subject }) }],
      maxTokens: REPLY_MAX_TOKENS,
      signal: ctx.signal,
    });
    const parsed = parseConsolidationReply(reply);
    reading.candidates.push(...parsed.candidates.map((c) => ({ ...c, part: i })));
    reading.dropped.push(...parsed.dropped.map((d) => d.problem));
  }
  saveRun(ctx, { reading });
  return reading;
}

/**
 * Check each candidate by itself (`checkCandidates`) and keep the ones that
 * failed, with their problems, in the job's checkpoint beside the model's answer,
 * before anything is written. Those checks read whether an updated note exists,
 * so a note this run makes would let a retry accept an update the first attempt
 * refused, and write a value the first attempt never chose; a retry reuses these
 * verdicts instead.
 */
function checkOnce(app: App, ctx: JobContext, source: ConsolidationSource, candidates: readonly Numbered[]): Failed[] {
  const { dropped } = checkCandidates(app.memory, candidates, { text: source.parts().join("\n\n"), noun: SUBJECTS[source.subject].noun });
  const failed = dropped.map((d) => ({ candidate: d.candidate.index, problem: d.problem }));
  saveRun(ctx, { failed });
  return failed;
}

/**
 * Write each accepted candidate to the Brain as its own change, without review.
 * A run that stopped partway, after a failed write or a crash, is recovered per
 * change: the caller left out what an earlier attempt of this run wrote, and
 * what is left is written now.
 * The job's checkpoint names each batch, with the candidate it writes, before it
 * is written, so a run tried again counts only its own earlier batches, never
 * those another job wrote from the same session meanwhile; a named batch that
 * failed has no changes and is not counted.
 * The checkpoint also keeps why each change was dropped, once each, so a drop in
 * an attempt that failed afterwards is still reported when a later attempt finishes.
 * Returns why changes were dropped while writing.
 */
async function write(app: App, ctx: JobContext, source: ConsolidationSource, accepted: readonly Numbered[]): Promise<string[]> {
  const record: WriteRecord<Numbered> = {
    newBatch: (c) => {
      const id = randomUUID();
      saveRun(ctx, { batches: [...runSoFar(ctx).batches, { id, candidate: c.index }] });
      return id;
    },
    dropped: (problem) => {
      const now = runSoFar(ctx).dropped;
      if (!now.includes(problem)) saveRun(ctx, { dropped: [...now, problem] });
    },
  };
  const out = await ctx.effect(
    `${source.effectKey}:write`,
    async () => {
      writeCandidates(app.memory, app.log, accepted, source.cite, source.from, record);
      return { dropped: runSoFar(ctx).dropped };
    },
    async () => (accepted.length ? null : { dropped: runSoFar(ctx).dropped }),
  );
  return out.dropped;
}

/**
 * Record each accepted candidate as a Proposal for the owner to decide.
 * Like a write, each Proposal is named in the job's checkpoint, with the
 * candidate it records, before it is made; after a crash the caller left out
 * what an earlier attempt proposed, and what is left is proposed now, so none is made twice.
 * Returns why changes were dropped while proposing: none are.
 */
async function propose(app: App, ctx: JobContext, source: ConsolidationSource, accepted: readonly Numbered[]): Promise<string[]> {
  await ctx.effect(
    `${source.effectKey}:propose`,
    async () => {
      for (const c of accepted) {
        const id = randomUUID();
        saveRun(ctx, { proposals: [...runSoFar(ctx).proposals, { id, candidate: c.index }] });
        app.proposals.proposeItems([c.item], {
          reason: c.reason,
          source: source.cite(c.evidence),
          ...(source.origin ? { origin: source.origin } : {}),
          evidence: c.evidence,
          proposedBy: CONSOLIDATED_BY,
          ids: [id],
        });
      }
      return {};
    },
    async () => (accepted.length ? null : {}),
  );
  return [];
}

/** The batches an earlier attempt of this run named and wrote; a named batch that failed has no changes. */
const ownWrites = (app: App, ctx: JobContext): Named[] => runSoFar(ctx).batches.filter((b) => app.memory.changesInBatch(b.id).length > 0);
/** The Proposals an attempt of this run named and made; a named Proposal that failed does not exist. */
const ownProposals = (app: App, ctx: JobContext): Named[] => runSoFar(ctx).proposals.filter((p) => app.proposals.has(p.id));

/** A candidate with its place in the model's answer, which stays the same in every attempt of a run. */
type Numbered = Candidate & { part: number; index: number };
/** What the model found in the source, and why it dropped entries of its own reply. */
type Reading = { candidates: Array<Candidate & { part: number }>; dropped: string[] };
/** A batch or Proposal a run named before making it, and the candidate it holds. */
type Named = { id: string; candidate: number };
/** A candidate that failed the checks on it by itself, and why. */
type Failed = { candidate: number; problem: string };
/**
 * What a run has done so far: what the model found, which of its candidates failed
 * the checks on them by themselves, each batch and Proposal it named, and why it
 * dropped changes while writing.
 */
type RunCheckpoint = { reading?: Reading; failed?: Failed[]; batches: Named[]; proposals: Named[]; dropped: string[] };

const runSoFar = (ctx: JobContext): RunCheckpoint => ({ batches: [], proposals: [], dropped: [], ...ctx.checkpoint<Partial<RunCheckpoint>>() });
const saveRun = (ctx: JobContext, change: Partial<RunCheckpoint>) => ctx.saveCheckpoint({ ...runSoFar(ctx), ...change } satisfies RunCheckpoint);
