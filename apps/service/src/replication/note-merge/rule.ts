import type { MergeInput, MergeOutcome, MergeRule } from "../seams.ts";
import { mergeFacts } from "./facts.ts";
import { mergeFrontmatter } from "./frontmatter.ts";
import { mergeHistory } from "./history.ts";
import { joinNote, NO_NOTE, splitNote, type NoteParts } from "./parts.ts";
import { takeTheOnlyChange, type ProseMerge } from "./prose.ts";
import { inAgreedOrder, type Side } from "./sides.ts";

export interface NoteMergeOptions {
  /** How prose both sides changed is merged; by default only prose one side changed merges. */
  prose?: ProseMerge;
}

/** Curated notes: everything under `memory/` that is Markdown. */
export const isNotePath = (path: string) => path.startsWith("memory/") && path.endsWith(".md");

function mergeNote(input: MergeInput, ours: string, theirs: string, prose: ProseMerge): MergeOutcome | null {
  const base = input.base === null ? NO_NOTE : splitNote(input.base);
  const [o, t] = [splitNote(ours), splitNote(theirs)];
  if (!base || !o || !t) return null;
  const [first, second] = inAgreedOrder<NoteParts>({ value: o, machine: input.local }, { value: t, machine: input.remote });
  const sideOf = <T>(side: Side<NoteParts>, pick: (p: NoteParts) => T): Side<T> => ({ value: pick(side.value), machine: side.machine });

  const text = prose({ path: input.path, base: input.base === null ? null : base.prose, first: sideOf(first, (p) => p.prose), second: sideOf(second, (p) => p.prose) });
  if (!text) return null;
  const facts = mergeFacts(base.facts, sideOf(first, (p) => p.facts), sideOf(second, (p) => p.facts));
  const history = mergeHistory(first.value.history, second.value.history, facts.superseded);
  const frontmatterText = mergeFrontmatter(base, first, second);
  const content = joinNote({ frontmatterText, facts: facts.facts, history, prose: text.text });
  return { content, ...(text.notices?.length ? { notices: text.notices } : {}) };
}

/**
 * The note merge rule: when two Machines changed the same note while apart,
 * facts merge by subject (the newer date wins, the other value goes to
 * History naming its Machine), History keeps every line from both sides once,
 * frontmatter merges field by field, and the prose goes to `options.prose`.
 * Two notes with the same type and title share a path, so they merge as one.
 * Every Machine that merges the same two versions writes the same note.
 */
export function noteMergeRule(options: NoteMergeOptions = {}): MergeRule {
  const prose = options.prose ?? takeTheOnlyChange;
  return {
    name: "note",
    appliesTo: isNotePath,
    merge(input) {
      // A note one side deleted is the deleted-and-changed rule's, which runs first and tells the owner.
      if (input.ours === null || input.theirs === null) return null;
      return mergeNote(input, input.ours, input.theirs, prose);
    },
  };
}
