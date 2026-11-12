import { plural } from "@jarvis/contracts";
import type { MemoryChange } from "../memory/store.ts";
import type { MachineRef } from "./seams.ts";

export interface StagedEntry {
  path: string;
  change: "added" | "modified" | "deleted";
}

const SUBJECT_MAX = 120;

/** The trailer that names the Machine a commit came from, read back when merging. */
export const MACHINE_TRAILER = "Jarvis-Machine";

type FactOutcome = "added" | "corrected" | "removed";

/**
 * What these changes did to each subject of a note, from its value before the
 * first change to its value after the last: a subject the note did not have is
 * added, one whose value was replaced is corrected, one taken out is removed.
 */
function factOutcomes(changes: readonly MemoryChange[]): Record<FactOutcome, string[]> {
  const spans = new Map<string, { subject: string; before: string | null; after: string | null }>();
  for (const c of [...changes].sort((a, b) => a.seq - b.seq)) {
    if (c.change !== "correct") continue;
    const subject = c.subject ?? "a fact";
    const key = subject.toLowerCase();
    spans.set(key, { subject, before: spans.has(key) ? spans.get(key)!.before : c.beforeValue, after: c.afterValue });
  }
  const outcomes: Record<FactOutcome, string[]> = { added: [], corrected: [], removed: [] };
  for (const { subject, before, after } of spans.values()) {
    if (before === null && after !== null) outcomes.added.push(subject);
    else if (before !== null && after !== null) outcomes.corrected.push(subject);
    else if (before !== null) outcomes.removed.push(subject);
  }
  return outcomes;
}

/** What the change log says happened to one file, e.g. `added Owner, corrected Status, added an event`. */
function describeChanges(changes: readonly MemoryChange[]): string {
  const created = changes.filter((c) => c.change === "create");
  const facts = factOutcomes(changes);
  const events = changes.filter((c) => c.change === "append").length;
  const deleted = changes.some((c) => c.change === "delete");
  return [
    ...created.map((c) => `created "${c.afterValue ?? c.docRelPath}"`),
    ...(["added", "corrected", "removed"] as const).filter((o) => facts[o].length).map((o) => `${o} ${facts[o].join(", ")}`),
    ...(events ? [`added ${events === 1 ? "an event" : plural(events, "event")}`] : []),
    ...(deleted && !created.length ? ["deleted the note"] : []),
  ].join(", ");
}

const BY_GIT: Record<StagedEntry["change"], string> = { added: "added", modified: "edited", deleted: "deleted" };

/**
 * A commit message that names what changed and the Machine: the change log
 * says what a save did to a note; a file the change log does not know about
 * (an edit by hand, evidence) is named with what git saw.
 */
export function commitMessage(machine: MachineRef, staged: readonly StagedEntry[], changes: readonly MemoryChange[]): string {
  const lines = staged.map((s) => {
    const own = changes.filter((c) => c.docRelPath === s.path && c.status === "applied");
    return { path: s.path, what: (own.length && describeChanges(own)) || BY_GIT[s.change] };
  });
  const first = lines[0];
  const more = lines.length > 1 ? ` (and ${plural(lines.length - 1, "more file")})` : "";
  const subject = first ? `${machine.name}: ${first.what} in ${first.path}${more}` : `${machine.name}: no changes`;
  return [subject.length > SUBJECT_MAX ? `${subject.slice(0, SUBJECT_MAX - 1)}…` : subject, "", ...lines.map((l) => `- ${l.path}: ${l.what}`), "", machineTrailer(machine)].join("\n");
}

export function machineTrailer(machine: MachineRef): string {
  return `${MACHINE_TRAILER}: ${machine.name}${machine.id ? ` (${machine.id})` : ""}`;
}
