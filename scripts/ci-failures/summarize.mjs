/**
 * What went wrong in one job of a GitHub Actions run, from the job as `gh run view --json jobs`
 * describes it, its log and its check-run annotations.
 */
import { findFailures, lastWords } from "./failures.mjs";
import { cleanLog, stepSections } from "./log.mjs";

const FAILED = new Set(["failure", "timed_out", "cancelled"]);

/** A job with no steps never ran: GitHub's failure annotation says why (billing, spending limit), if anything does. */
function whyNotStarted(job, annotations) {
  const reasons = annotations.filter((a) => a.annotation_level === "failure").map((a) => a.message.trim());
  if (reasons.length) return reasons.join(" ");
  return job.conclusion === "cancelled" ? "cancelled before it started" : `${job.conclusion} before it started`;
}

/**
 * @param {{ job: { name: string, conclusion: string, steps: Array<{ number: number, name: string, conclusion: string | null }> }, log: string, annotations: Array<{ annotation_level: string, message: string }> }} input
 */
export function summarizeJob({ job, log, annotations }) {
  if (!job.steps.length) return { name: job.name, conclusion: job.conclusion, notStarted: whyNotStarted(job, annotations), steps: [] };
  const lines = cleanLog(log);
  const sections = stepSections(lines, job.steps);
  const steps = job.steps
    .filter((s) => FAILED.has(s.conclusion))
    .map((s) => {
      const section = sections?.get(s.number) ?? lines;
      const failures = findFailures(section);
      return { name: s.name, failures, output: failures.length ? [] : lastWords(section) };
    });
  return { name: job.name, conclusion: job.conclusion, steps };
}
