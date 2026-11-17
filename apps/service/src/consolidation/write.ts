import type { Logger } from "../core/log.ts";
import { HttpError } from "../http/router.ts";
import type { ConsolidationFrom } from "../memory/change-log.ts";
import { CONSOLIDATION_ACTOR, PolicyError } from "../memory/policy.ts";
import { checkItems, writeItem, type ItemWriter } from "../memory/save-items.ts";
import type { MemoryStore, SourceRef } from "../memory/store.ts";
import type { Candidate } from "./reply.ts";

/** Consolidation writes as itself, so the change log and the note's History tell its changes from the owner's. */
const WRITER: ItemWriter = { actor: CONSOLIDATION_ACTOR, provenance: "consolidated" };

const changeOrigin = (from: ConsolidationFrom) => ("capture" in from ? { harness: null, sessionId: null, capture: from.capture } : { harness: from.harness, sessionId: from.sessionId, capture: null });

/**
 * Where a writing run records what it does as it goes, so an attempt that
 * fails partway leaves its record for the next attempt to build on.
 */
export interface WriteRecord<C extends Candidate> {
  /** Name a new batch for the change `candidate` makes, before anything is written in it. */
  newBatch(candidate: C): string;
  /** Note why a change was not written. */
  dropped(problem: string): void;
}

/**
 * Write each screened candidate to the Brain straight away, as its own batch,
 * so each shows and reverts on its own in the change log, marked as written
 * without review. Each item is checked again just before it is written,
 * because an earlier one may have changed the Brain; one that no longer
 * passes is dropped, never forced. `record` names each batch before it is
 * written and keeps each drop's problem, so the caller knows which batches and
 * drops are its own even when a later write throws. Returns the batch ids written.
 */
export function writeCandidates<C extends Candidate>(
  memory: MemoryStore,
  log: Logger,
  accepted: readonly C[],
  cite: (evidence: string) => SourceRef | null,
  from: ConsolidationFrom,
  record: WriteRecord<C>,
): string[] {
  const origin = changeOrigin(from);
  const batches: string[] = [];
  for (const c of accepted) {
    try {
      const [step] = checkItems(memory, [c.item]);
      const batchId = record.newBatch(c);
      writeItem(memory, step!, cite(c.evidence), WRITER, { ...origin, batchId, autoAccepted: true });
      batches.push(batchId);
    } catch (e) {
      if (!(e instanceof HttpError || e instanceof PolicyError)) throw e;
      log.info("Consolidation dropped a change the Brain no longer accepts", { ...origin, problem: e.message });
      record.dropped(`it no longer passes the checks a save passes: ${e.message}`);
    }
  }
  return batches;
}
