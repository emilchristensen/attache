import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Observation } from "../connectors/types.ts";
import { parseMarkdown, parseStateEntries, type StateEntry } from "../memory/markdown.ts";
import { isPastReview } from "../memory/review-date.ts";

/** The attention kind of an inbox item for a fact past its Review date. */
export const FACT_REVIEW_KIND = "fact-review";
/** Curated memory: the only place a fact with a Review date lives. */
const MEMORY_PREFIX = "memory/";
/** Below the urgent threshold (70), so a passed Review date never raises a desktop notification. */
const PRIORITY = 40;

/**
 * One observation per fact past its Review date in one note, each carrying an
 * inbox item keyed by note and subject. The fingerprint covers the value, the
 * fact's date and its Review date, so a dismissed item stays dismissed until
 * one of them changes. A fact that is corrected, or given a later Review date,
 * is no longer observed, and its item is resolved on the next full refresh.
 */
export function factReviewObservations(relPath: string, raw: string, now: Date): Observation[] {
  const title = parseMarkdown(raw, relPath.replace(/\.md$/, "").split("/").pop()!).title;
  const seen = new Set<string>();
  const out: Observation[] = [];
  for (const fact of parseStateEntries(raw)) {
    const subject = fact.subject.toLowerCase();
    if (!isPastReview(fact.review, now) || seen.has(subject)) continue;
    seen.add(subject);
    out.push(observation(relPath, title, fact as StateEntry & { review: string }));
  }
  return out;
}

function observation(relPath: string, title: string, fact: StateEntry & { review: string }): Observation {
  const externalId = `${relPath}:${fact.subject.toLowerCase()}`;
  return {
    kind: FACT_REVIEW_KIND,
    externalId,
    title: `${title}: ${fact.subject}`,
    occurredAt: fact.review,
    data: { relPath, line: fact.line, subject: fact.subject, review: fact.review, noteTitle: title },
    fingerprintParts: [fact.value, fact.date, fact.review],
    attention: {
      key: `${FACT_REVIEW_KIND}:${externalId}`,
      kind: FACT_REVIEW_KIND,
      title: `Review date passed: “${fact.subject}” in ${title}`,
      summary: `${title} says “${fact.subject}: ${fact.value}” (${relPath}, line ${fact.line}). Its Review date ${fact.review} has passed.`,
      why: "Until it is checked, this fact is shown as unverified. Correct it, or confirm it with a later Review date.",
      priority: PRIORITY,
    },
  };
}

/** Facts past their Review date across the Brain's curated notes. Unreadable files are reported, not fatal. */
export function scanFactReviews(root: string, relPaths: readonly string[], now: Date): { observations: Observation[]; errors: string[] } {
  const observations: Observation[] = [];
  const errors: string[] = [];
  for (const rel of relPaths.filter((p) => p.startsWith(MEMORY_PREFIX))) {
    try {
      observations.push(...factReviewObservations(rel, readFileSync(join(root, rel), "utf8"), now));
    } catch (e) {
      errors.push(`${rel}: ${(e as Error).message}`);
    }
  }
  return { observations, errors };
}
