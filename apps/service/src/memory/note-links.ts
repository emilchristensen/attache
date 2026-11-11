import { basename } from "node:path";
import { parseMarkdown, parseStateEntries, type StateEntry } from "./markdown.ts";

/**
 * When two curated notes are linked. Notes carry no link field: a note is
 * linked to another when either one names the other in what it says, its
 * current facts' values or its prose. A note is named by its title, as a
 * whole phrase in any case, or by its file name, which is what a Markdown
 * link (`[Orion](../projects/orion-migration.md)`) or a wiki link
 * (`[[orion-migration]]`) carries. Sources and History are not read: they
 * name where a fact came from, not what it is about.
 */

/** Titles shorter than this name too much by accident ("AI", "QA"). */
const MIN_NAME_CHARS = 3;
const SKIPPED_SECTIONS = new Set(["current state", "history"]);

export interface BrainNote {
  relPath: string;
  type: string;
  title: string;
  state: StateEntry[];
  /** What the note says, lower-cased: its current facts' values and its prose. */
  text: string;
}

/** A note as linking reads it, from its raw Markdown. */
export function brainNote(doc: { relPath: string; type: string; title: string }, raw: string): BrainNote {
  const state = parseStateEntries(raw);
  const prose = parseMarkdown(raw, doc.title)
    .sections.filter((s) => !SKIPPED_SECTIONS.has((s.heading ?? "").trim().toLowerCase()))
    .map((s) => s.text);
  return { ...doc, state, text: [...state.map((f) => f.value), ...prose].join("\n").toLowerCase() };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `text` (lower-cased) names `note`. */
function names(text: string, note: Pick<BrainNote, "relPath" | "title">): boolean {
  const title = note.title.trim().toLowerCase();
  const stem = basename(note.relPath, ".md").toLowerCase();
  const phrase = (s: string, word: string) => s.length >= MIN_NAME_CHARS && new RegExp(`(?<![${word}])${escape(s)}(?![${word}])`, "u").test(text);
  return phrase(title, "\\p{L}\\p{N}") || phrase(stem, "\\p{L}\\p{N}_-");
}

/** The notes among `others` that name `note` or that `note` names, in the order given. */
export function linkedNotes(note: BrainNote, others: readonly BrainNote[]): BrainNote[] {
  return others.filter((o) => o.relPath !== note.relPath && (names(note.text, o) || names(o.text, note)));
}
