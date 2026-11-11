import { z } from "zod";
import type { MeaningRanking } from "./meaning.ts";

/** API contract: Recall evaluation. */

/** One question and the fact expected to answer it: a note in the Brain and the subject of one of its current facts. */
export const RecallQuestion = z.object({
  question: z.string().trim().min(1).max(500),
  /** The note's path inside the Brain, e.g. `memory/projects/orion-migration.md`. */
  note: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .transform((p) => p.replace(/^(\.\/)+/, ""))
    .refine((p) => p.endsWith(".md") && !p.startsWith("/") && !p.split("/").includes(".."), "must be a Markdown file's path inside the Brain"),
  /** The subject of the current fact, as written between `**` in the note. */
  fact: z.string().trim().min(1).max(100),
});
export type RecallQuestion = z.infer<typeof RecallQuestion>;

export const RecallQuestionSet = z.object({ questions: z.array(RecallQuestion).min(1).max(1000) });
export type RecallQuestionSet = z.infer<typeof RecallQuestionSet>;

/** Score a supplied question set, or, without one, the set kept in the Brain. */
export const RecallEvaluationInput = z.object({ set: RecallQuestionSet.optional() });
export type RecallEvaluationInput = z.infer<typeof RecallEvaluationInput>;

export interface RecallEvaluationHit {
  root: string;
  relPath: string;
  title: string;
  /** The fact this hit is, when it is one. */
  fact: string | null;
  startLine: number;
  endLine: number;
  snippet: string;
}

export interface RecallEvaluationReport {
  generatedAt: string;
  /** Where the questions came from: the Brain's own set (its path inside the Brain) or the caller. */
  set: { source: "brain"; path: string } | { source: "supplied" };
  /** How search ranked while the set was scored: by keywords alone, or by meaning as well. */
  ranking: MeaningRanking;
  /** Questions scored. Questions whose expected fact is not in the Brain are listed under `invalid` instead. */
  questions: number;
  /** How many questions have the expected fact as the first result. */
  top1: number;
  /** How many questions have the expected fact in the first three results. */
  top3: number;
  top1Rate: number;
  top3Rate: number;
  /** Every scored question whose expected fact is not the first result, with the first three results. */
  misses: Array<RecallQuestion & { rank: number | null; returned: RecallEvaluationHit[] }>;
  /** Questions that cannot be scored, because their note or fact is not in the Brain. */
  invalid: Array<RecallQuestion & { problem: string }>;
}
