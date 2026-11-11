import { existsSync, readFileSync } from "node:fs";
import { RecallQuestionSet, type RecallEvaluationHit, type RecallEvaluationReport, type RecallQuestion } from "@jarvis/contracts";
import type { Db } from "../core/db.ts";
import { nowIso } from "../core/db.ts";
import { HttpError } from "../http/router.ts";
import { parseStateEntries, parseStateLine } from "./markdown.ts";
import { resolveInside } from "./policy.ts";
import { RECALL_EXCLUDE, search, type SearchHit } from "./search.ts";

/** Where a Brain keeps its own question set. JSON, so the indexer never reads it and its questions never match themselves. */
export const RECALL_SET_PATH = "evaluation/recall-questions.json";

/** As many results as a Harness asks for by default; a question is ranked among these. */
const RESULTS_SEARCHED = 8;
/** The results a miss shows: the ones the "first three" measure looks at. */
const RESULTS_SHOWN = 3;

/** The Brain's own question set, validated. */
export function loadBrainQuestionSet(dataRoot: string): RecallQuestionSet {
  const abs = resolveInside(dataRoot, RECALL_SET_PATH);
  if (!existsSync(abs)) throw new HttpError(404, "no_question_set", `This Brain has no recall question set. Write one to ${abs}, shaped as { "questions": [{ "question": "…", "note": "memory/…/note.md", "fact": "Subject" }] }.`);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new HttpError(422, "invalid_question_set", `${RECALL_SET_PATH} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = RecallQuestionSet.safeParse(data);
  if (!parsed.success) throw new HttpError(422, "invalid_question_set", `${RECALL_SET_PATH} is not a recall question set:\n${describeIssues(parsed.error.issues)}`);
  return parsed.data;
}

export function describeIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  return issues.map((i) => `  - ${i.path.map(String).join(".") || "(root)"}: ${i.message}`).join("\n");
}

/**
 * Score search against a question set: how often the expected fact is the
 * first result, and how often it is in the first three. Search runs exactly as
 * it does for a Harness, so a change to ranking shows up here.
 */
export function evaluateRecall(db: Db, dataRoot: string, set: RecallQuestionSet, source: RecallEvaluationReport["set"]): RecallEvaluationReport {
  const invalid: RecallEvaluationReport["invalid"] = [];
  const scored: Array<RecallQuestion & { rank: number | null; returned: RecallEvaluationHit[] }> = [];
  for (const q of set.questions) {
    const problem = expectationProblem(dataRoot, q);
    if (problem) {
      invalid.push({ ...q, problem });
      continue;
    }
    const hits = search(db, q.question, { limit: RESULTS_SEARCHED, excludePrefixes: RECALL_EXCLUDE }).map(describeHit);
    const index = hits.findIndex((h) => isExpected(h, q));
    scored.push({ ...q, rank: index < 0 ? null : index + 1, returned: hits.slice(0, RESULTS_SHOWN) });
  }
  const top1 = scored.filter((s) => s.rank === 1).length;
  const top3 = scored.filter((s) => s.rank !== null && s.rank <= RESULTS_SHOWN).length;
  const rate = (n: number) => (scored.length ? n / scored.length : 0);
  return {
    generatedAt: nowIso(),
    set: source,
    questions: scored.length,
    top1,
    top3,
    top1Rate: rate(top1),
    top3Rate: rate(top3),
    misses: scored.filter((s) => s.rank !== 1),
    invalid,
  };
}

/** Why a question cannot be scored: its note or fact is not in the Brain. */
function expectationProblem(dataRoot: string, q: RecallQuestion): string | null {
  const abs = resolveInside(dataRoot, q.note);
  if (!existsSync(abs)) return `The note ${q.note} is not in the Brain.`;
  const subjects = parseStateEntries(readFileSync(abs, "utf8")).map((e) => e.subject);
  if (!subjects.some((s) => sameSubject(s, q.fact))) return `${q.note} has no current fact "${q.fact}". Its facts: ${subjects.join(", ") || "none"}.`;
  return null;
}

function describeHit(h: SearchHit): RecallEvaluationHit {
  const fact = h.section === "state" ? (parseStateLine(h.text.split("\n")[0] ?? "")?.subject ?? null) : null;
  return { root: h.root, relPath: h.relPath, title: h.title, fact, startLine: h.startLine, endLine: h.endLine, snippet: h.snippet };
}

function isExpected(h: RecallEvaluationHit, q: RecallQuestion): boolean {
  return h.root === "data" && h.relPath === q.note && h.fact !== null && sameSubject(h.fact, q.fact);
}

const sameSubject = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
