/**
 * Reading a GitHub Actions job log: plain text lines, and the part of the log each step wrote.
 */

// CSI sequences (colours, cursor moves) and OSC sequences (hyperlinks, titles).
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const STEP_START = "##[group]Run ";
// Steps GitHub runs around the workflow's own: they write no `Run` group.
const RUNNER_STEPS = new Set(["Set up job", "Complete job"]);

/** The log as plain lines: no byte order mark, carriage returns, timestamps or ANSI escape sequences. */
export function cleanLog(text) {
  return text
    .replace(/^﻿/, "")
    .split("\n")
    .map((line) => line.replace(/\r$/, "").replace(TIMESTAMP, "").replace(ANSI, "").replace(/\r/g, ""));
}

/** Whether a step is one of the workflow's own that ran, so it wrote a `Run` group in the log. */
const wroteGroup = (step) => !RUNNER_STEPS.has(step.name) && !step.name.startsWith("Post ") && step.conclusion !== "skipped" && step.conclusion !== null && step.conclusion !== undefined;

/**
 * The lines each step wrote, by step number. Steps that ran write their `Run` groups in order,
 * so the n-th group belongs to the n-th step that ran; "Set up job" wrote everything before the first.
 * Returns null when the groups and the steps do not line up (a composite action writes groups of its own).
 */
export function stepSections(lines, steps) {
  const starts = lines.flatMap((line, i) => (line.startsWith(STEP_START) ? [i] : []));
  const ran = steps.filter(wroteGroup).sort((a, b) => a.number - b.number);
  if (starts.length !== ran.length) return null;
  const end = lines.findIndex((line, i) => i > (starts.at(-1) ?? -1) && line === "Post job cleanup.");
  const bounds = [...starts, end === -1 ? lines.length : end];
  const sections = new Map(ran.map((step, i) => [step.number, lines.slice(bounds[i], bounds[i + 1])]));
  const setup = steps.find((s) => s.name === "Set up job");
  if (setup) sections.set(setup.number, lines.slice(0, starts[0] ?? lines.length));
  return sections;
}
