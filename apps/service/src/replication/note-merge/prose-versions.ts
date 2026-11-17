import { basename } from "node:path";
import type { MachineRef, MergeNotice } from "../seams.ts";
import { mergeLines, type MergedChunk } from "./line-merge.ts";
import { FACTS_PLACEHOLDER, HISTORY_PLACEHOLDER } from "./parts.ts";
import type { ProseMerge } from "./prose.ts";

/** The `MergeNotice.kind` raised when a note keeps two versions of the same lines. */
export const PROSE_VERSIONS = "prose_versions";

const VERSION_PREFIX = "Version from ";
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const PLACEHOLDERS = new Set([FACTS_PLACEHOLDER, HISTORY_PLACEHOLDER]);

interface Heading {
  readonly level: number;
  readonly text: string;
}

/** The headings of a Markdown text, in order, leaving out lines inside code fences. */
function headingsOf(lines: readonly string[]): readonly Heading[] {
  let inFence = false;
  return lines.flatMap((line) => {
    if (FENCE_RE.test(line)) inFence = !inFence;
    const m = inFence ? null : HEADING_RE.exec(line);
    return m ? [{ level: m[1]!.length, text: m[2]! }] : [];
  });
}

const isVersionHeading = (h: Heading) => h.text.startsWith(VERSION_PREFIX);

/** A Machine's name for a heading; with an id prefix when both Machines carry the same name. */
function machineLabel(machine: MachineRef, other: MachineRef): string {
  const name = machine.name.replace(/\s+/g, " ").trim() || "another Machine";
  const same = name.toLowerCase() === other.name.replace(/\s+/g, " ").trim().toLowerCase();
  return same && machine.id ? `${name} (${machine.id.slice(0, 8)})` : name;
}

/** The lines of a version without the blank lines around it. */
function trimBlank(lines: readonly string[]): readonly string[] {
  let [from, to] = [0, lines.length];
  while (from < to && lines[from]!.trim() === "") from++;
  while (to > from && lines[to - 1]!.trim() === "") to--;
  return lines.slice(from, to);
}

/** Two versions as Markdown: each under a heading one level below the section it sits in. */
function versionBlock(level: number, versions: ReadonlyArray<{ label: string; lines: readonly string[] }>): readonly string[] {
  const hashes = "#".repeat(level);
  return versions.flatMap(({ label, lines }) => {
    const body = trimBlank(lines);
    return ["", `${hashes} ${VERSION_PREFIX}${label}`, "", ...(body.length ? body : [`_${label}'s version has nothing here._`])];
  });
}

/** Writes merged chunks as one text; both versions of lines both sides changed stand under headings naming their Machines. */
function render(chunks: readonly MergedChunk[], first: MachineRef, second: MachineRef): readonly string[] {
  const out: string[] = [];
  let afterBlock = false;
  for (const chunk of chunks) {
    if (chunk.kind === "agreed") {
      // A block ends in a blank line; the text after it may bring its own.
      if (afterBlock && chunk.lines[0]?.trim() === "") out.pop();
      out.push(...chunk.lines);
      afterBlock = false;
      continue;
    }
    // The facts and History stand outside both versions: they merge by their own rules.
    const held = [...new Set([...chunk.first, ...chunk.second].filter((l) => PLACEHOLDERS.has(l)))];
    const strip = (lines: readonly string[]) => lines.filter((l) => !PLACEHOLDERS.has(l));
    out.push(...held);
    const section = headingsOf(out).filter((h) => !isVersionHeading(h)).at(-1)?.level ?? 1;
    const block = versionBlock(Math.min(6, section + 1), [
      { label: machineLabel(first, second), lines: strip(chunk.first) },
      { label: machineLabel(second, first), lines: strip(chunk.second) },
    ]);
    out.push(...(out.length === 0 || out.at(-1)!.trim() === "" ? block.slice(1) : block), "");
    afterBlock = true;
  }
  if (afterBlock) out.pop();
  return out;
}

/**
 * Whether a note still holds two versions side by side: two "Version from"
 * headings at the same level, one right after the other among the note's
 * version headings. Other headings do not count, as a version may hold some.
 * Removing one version, or its heading, settles it.
 */
export function holdsTwoVersions(text: string): boolean {
  const levels = headingsOf(text.split("\n"))
    .filter(isVersionHeading)
    .map((h) => h.level);
  return levels.some((level, i) => i > 0 && levels[i - 1] === level);
}

function noteTitle(path: string, lines: readonly string[]): string {
  const h1 = headingsOf(lines).find((h) => h.level === 1);
  return h1?.text ?? basename(path, ".md");
}

function notice(path: string, title: string, first: MachineRef, second: MachineRef): MergeNotice {
  return {
    path,
    kind: PROSE_VERSIONS,
    perPath: true,
    title: `Two versions kept in "${title}"`,
    message: `${first.name} and ${second.name} changed the same lines of "${title}" while apart. Attache kept both versions in the note, each under a heading naming its Machine. Keep the one you want and delete the other with its heading; this item then resolves by itself.`,
  };
}

/**
 * The prose merge: a three-way line merge. Changes to different lines all
 * merge; where both Machines changed the same lines, both versions are kept,
 * each under a heading with its Machine's name, and one notice asks the owner
 * to settle the note. It always merges, so Replication never waits on prose.
 */
export const keepBothVersions: ProseMerge = ({ path, base, first, second }) => {
  const chunks = mergeLines(base === null ? null : base.split("\n"), first.value.split("\n"), second.value.split("\n"));
  const lines = render(chunks, first.machine, second.machine);
  const kept = chunks.some((c) => c.kind === "versions");
  return { text: lines.join("\n"), ...(kept ? { notices: [notice(path, noteTitle(path, lines), first.machine, second.machine)] } : {}) };
};
