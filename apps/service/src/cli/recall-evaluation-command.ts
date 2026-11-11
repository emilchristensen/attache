import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RecallQuestionSet, type RecallEvaluationReport } from "@jarvis/contracts";
import type { ServicePaths } from "../core/paths.ts";
import type { CliIo } from "./memory-commands.ts";
import { ServiceClient } from "./client.ts";
import { describeIssues } from "../memory/recall-evaluation.ts";

const MAX_SET_BYTES = 2_000_000;

export const EVALUATE_RECALL_USAGE = `Usage: jarvis evaluate-recall [--set questions.json] [--json]

Scores search against a question set: how often the expected fact is the first result, and how often it is in the first three.
Without --set, uses the set kept in the Brain at evaluation/recall-questions.json.
A set is JSON: { "questions": [{ "question": "…", "note": "memory/projects/x.md", "fact": "Status" }] },
where "note" is the note's path inside the Brain and "fact" the subject of the current fact that answers the question.`;

/** `jarvis evaluate-recall`: score the running service's search against a question set. */
export async function evaluateRecallCommand(argv: string[], paths: ServicePaths, io: CliIo) {
  if (argv.includes("--help")) return io.out(EVALUATE_RECALL_USAGE);
  const setFile = flag(argv, "set");
  const set = setFile ? readQuestionSet(resolve(io.cwd, setFile)) : undefined;
  const report = await new ServiceClient(paths).post<RecallEvaluationReport>("/memory/recall-evaluation", set ? { set } : {});
  io.out(argv.includes("--json") ? JSON.stringify(report) : renderRecallEvaluation(report));
}

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value.\n\n${EVALUATE_RECALL_USAGE}`);
  return value;
}

function readQuestionSet(file: string): RecallQuestionSet {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`Could not read the question set ${file}: ${(e as Error).message}`);
  }
  if (raw.length > MAX_SET_BYTES) throw new Error(`The question set ${file} is larger than ${MAX_SET_BYTES / 1_000_000} MB.`);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`The question set ${file} is not valid JSON: ${(e as Error).message}`);
  }
  const parsed = RecallQuestionSet.safeParse(data);
  if (!parsed.success) throw new Error(`The question set ${file} does not match the expected shape:\n${describeIssues(parsed.error.issues)}\n\n${EVALUATE_RECALL_USAGE}`);
  return parsed.data;
}

const percent = (rate: number) => `${Math.round(rate * 100)}%`;

export function renderRecallEvaluation(r: RecallEvaluationReport): string {
  const from = r.set.source === "brain" ? `the Brain's set (${r.set.path})` : "the supplied set";
  const lines = [
    `Recall evaluation: ${r.questions} questions from ${from}`,
    `First result: ${r.top1} of ${r.questions} (${percent(r.top1Rate)})`,
    `In the first three: ${r.top3} of ${r.questions} (${percent(r.top3Rate)})`,
  ];
  for (const m of r.misses) {
    lines.push("", `${m.rank === null ? "Not found" : `Found at ${m.rank}`}: ${m.question}`, `  expected: ${m.note} · ${m.fact}`);
    if (!m.returned.length) lines.push("  returned: nothing");
    m.returned.forEach((h, i) => lines.push(`  ${i + 1}. ${h.relPath}:${h.startLine}-${h.endLine}${h.fact ? ` · ${h.fact}` : ""}  ${h.snippet}`));
  }
  if (r.invalid.length) {
    lines.push("", `Not scored (${r.invalid.length}): fix these questions or the Brain`);
    for (const q of r.invalid) lines.push(`- ${q.question}`, `  ${q.problem}`);
  }
  return lines.join("\n");
}
