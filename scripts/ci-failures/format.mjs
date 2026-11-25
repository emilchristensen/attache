/**
 * The short text report `scripts/ci-failures.mjs` prints for a run.
 */

const MAX_FAILURES = 8;

function stepLines(job, step) {
  const lines = [`${job.name}: ${step.name} ${job.stopped ? "cancelled" : "failed"}`];
  for (const f of step.failures.slice(0, MAX_FAILURES)) lines.push(`  ${f.test}`, ...f.errors.map((e) => `    ${e}`));
  if (step.failures.length > MAX_FAILURES) lines.push(`  … and ${step.failures.length - MAX_FAILURES} more`);
  lines.push(...step.output.map((o) => `    ${o}`));
  return lines;
}

function jobLines(job) {
  const stopped = job.stopped ? [`${job.name}: ${job.stopped}`] : [];
  if (!job.steps.length) return [...(stopped.length ? stopped : [`${job.name}: ${job.conclusion}, but no step failed`]), ""];
  return [...stopped, ...job.steps.flatMap((step) => [...stepLines(job, step), ""])];
}

/**
 * @param {{ databaseId: number, displayTitle: string, headBranch: string, conclusion: string | null, status?: string, url: string }} run
 * @param {Array<ReturnType<typeof import("./summarize.mjs").summarizeJob>>} jobs the jobs that did not succeed
 */
export function formatRun(run, jobs) {
  const header = [`Run ${run.databaseId} ${run.conclusion || run.status}: ${run.displayTitle} (${run.headBranch})`, run.url, ""];
  const ran = jobs.filter((j) => !j.notStarted);
  // Jobs that never started usually share one reason (billing, a cancelled run): say it once.
  const reasons = Map.groupBy(
    jobs.filter((j) => j.notStarted),
    (j) => j.notStarted,
  );
  const notStarted = [...reasons].map(([reason, js]) => `Not started: ${js.map((j) => j.name).join(", ")}. ${reason}`);
  const body = jobs.length ? [...ran.flatMap(jobLines), ...(notStarted.length ? [...notStarted, ""] : [])] : ["No job failed.", ""];
  return [...header, ...body].join("\n");
}
