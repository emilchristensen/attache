import type { MergeNotice } from "../seams.ts";
import type { Side } from "./sides.ts";

/**
 * The prose of a note: everything but its frontmatter, facts and History
 * items, which stand as placeholder lines (see `parts.ts`) that a prose merge
 * keeps as they are.
 */
export interface ProseMergeInput {
  readonly path: string;
  /** Null when both sides created the note. */
  readonly base: string | null;
  /** The two sides in the order every Machine agrees on (see `sides.ts`). */
  readonly first: Side<string>;
  readonly second: Side<string>;
}

export interface MergedProse {
  readonly text: string;
  readonly notices?: readonly MergeNotice[];
}

/** Merges the prose of a note both sides changed; null when it cannot, which leaves the note unmerged. */
export type ProseMerge = (input: ProseMergeInput) => MergedProse | null;

/**
 * Prose that only one side changed, or that both changed the same way.
 * Prose both sides changed differently is left to a richer prose merge.
 */
export const takeTheOnlyChange: ProseMerge = ({ base, first, second }) => {
  if (first.value === second.value || second.value === base) return { text: first.value };
  if (first.value === base) return { text: second.value };
  return null;
};
