import type { MemoryChange } from "../memory/store.ts";
import type { MachineRef } from "./seams.ts";

export interface StagedEntry {
  path: string;
  change: "added" | "modified" | "deleted";
}

const SUBJECT_MAX = 120;

/** The trailer that names the Machine a commit came from, read back when merging. */
export const MACHINE_TRAILER = "Jarvis-Machine";

function count(n: number, one: string, many: string) {
  return n === 1 ? one : `${n} ${many}`;
}

/** What the change log says happened to one file, e.g. `corrected Status, added an event`. */
function describeChanges(changes: readonly MemoryChange[]): string {
  const created = changes.filter((c) => c.change === "create");
  const corrected = [...new Set(changes.filter((c) => c.change === "correct" && c.afterValue !== null).map((c) => c.subject ?? "a fact"))];
  const removed = [...new Set(changes.filter((c) => c.change === "correct" && c.afterValue === null).map((c) => c.subject ?? "a fact"))];
  const events = changes.filter((c) => c.change === "append").length;
  const deleted = changes.some((c) => c.change === "delete");
  return [
    ...created.map((c) => `created "${c.afterValue ?? c.docRelPath}"`),
    ...(corrected.length ? [`corrected ${corrected.join(", ")}`] : []),
    ...(removed.length ? [`removed ${removed.join(", ")}`] : []),
    ...(events ? [`added ${count(events, "an event", "events")}`] : []),
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
  const more = lines.length > 1 ? ` (and ${count(lines.length - 1, "1 more file", "more files")})` : "";
  const subject = first ? `${machine.name}: ${first.what} in ${first.path}${more}` : `${machine.name}: no changes`;
  return [subject.length > SUBJECT_MAX ? `${subject.slice(0, SUBJECT_MAX - 1)}…` : subject, "", ...lines.map((l) => `- ${l.path}: ${l.what}`), "", machineTrailer(machine)].join("\n");
}

export function machineTrailer(machine: MachineRef): string {
  return `${MACHINE_TRAILER}: ${machine.name}${machine.id ? ` (${machine.id})` : ""}`;
}
