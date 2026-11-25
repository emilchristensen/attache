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

const TIME_LIMIT = /exceeded the maximum execution time of (\S+)/;
const SUPERSEDED = /^Canceling since a higher priority waiting request/;

/**
 * Why GitHub stopped a job that had started, from its annotations: its own time limit (how long it ran, and in which
 * step), or a newer run of the same branch that replaced it. Null for a job that ended on its own.
 */
function whyStopped(job, annotations) {
  const failures = annotations.filter((a) => a.annotation_level === "failure").map((a) => a.message.trim());
  if (failures.some((m) => SUPERSEDED.test(m))) return { reason: "cancelled: a newer run for the same branch replaced it", readSteps: false };
  const limit = failures.map((m) => TIME_LIMIT.exec(m)?.[1]).find(Boolean);
  if (!limit) return null;
  const minutes = job.startedAt && job.completedAt ? ` after ${Math.round((Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 60_000)} min` : "";
  const step = job.steps.find((s) => FAILED.has(s.conclusion));
  return { reason: `stopped at its ${limit} time limit${minutes}${step ? `, during ${step.name}` : ""}`, readSteps: true };
}

/**
 * @param {{ job: { name: string, conclusion: string, startedAt?: string, completedAt?: string, steps: Array<{ number: number, name: string, conclusion: string | null }> }, log: string, annotations: Array<{ annotation_level: string, message: string }> }} input
 */
export function summarizeJob({ job, log, annotations }) {
  if (!job.steps.length) return { name: job.name, conclusion: job.conclusion, notStarted: whyNotStarted(job, annotations), steps: [] };
  const stopped = whyStopped(job, annotations);
  if (stopped && !stopped.readSteps) return { name: job.name, conclusion: job.conclusion, stopped: stopped.reason, steps: [] };
  const lines = cleanLog(log);
  const sections = stepSections(lines, job.steps);
  const steps = job.steps
    .filter((s) => FAILED.has(s.conclusion))
    .map((s) => {
      const section = sections?.get(s.number) ?? lines;
      const failures = findFailures(section);
      return { name: s.name, failures, output: failures.length ? [] : lastWords(section) };
    });
  return { name: job.name, conclusion: job.conclusion, ...(stopped ? { stopped: stopped.reason } : {}), steps };
}
