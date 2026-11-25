#!/usr/bin/env node
/**
 * What failed in a GitHub Actions run, in a few lines per job: the failed step, the failing tests
 * and their first error lines, why GitHub stopped a job (its time limit, a newer run), or why a job
 * never started (billing, cancelled).
 * Uses the GitHub CLI (`gh`), signed in to an account that can read the repository.
 * Usage: node scripts/ci-failures.mjs <run-id|run-url>
 */
import { formatRun } from "./ci-failures/format.mjs";
import { currentRepo, fetchAnnotations, fetchJobLog, fetchRun, parseRunRef } from "./ci-failures/gh.mjs";
import { summarizeJob } from "./ci-failures/summarize.mjs";

const NOT_FAILED = new Set(["success", "skipped", "neutral"]);

/** A job's summary; a log GitHub no longer has (or never wrote) still leaves the failed step's name. */
function summarize(repo, job) {
  if (!job.steps.length) return summarizeJob({ job, log: "", annotations: fetchAnnotations(repo, job.databaseId) });
  try {
    return summarizeJob({ job, log: fetchJobLog(repo, job.databaseId), annotations: fetchAnnotations(repo, job.databaseId) });
  } catch (e) {
    const summary = summarizeJob({ job, log: "", annotations: [] });
    return { ...summary, steps: summary.steps.map((s) => ({ ...s, output: [`(no log: ${e.message})`] })) };
  }
}

function main() {
  const ref = parseRunRef(process.argv[2]);
  const repo = ref.repo ?? currentRepo();
  const run = fetchRun(repo, ref.runId);
  const failed = run.jobs.filter((j) => j.status === "completed" && !NOT_FAILED.has(j.conclusion));
  process.stdout.write(formatRun(run, failed.map((job) => summarize(repo, job))));
  const running = run.jobs.filter((j) => j.status !== "completed").length;
  if (running) process.stdout.write(`${running} job(s) still running.\n`);
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
