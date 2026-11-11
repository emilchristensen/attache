import { commonLines, diffLines, type Hunk } from "./line-diff.ts";

/** A stretch of the merged text: lines both sides agree on, or lines each side changed its own way. */
export type MergedChunk = { readonly kind: "agreed"; readonly lines: readonly string[] } | { readonly kind: "versions"; readonly first: readonly string[]; readonly second: readonly string[] };

interface SideHunk extends Hunk {
  readonly side: 0 | 1;
}

/** One stretch of base lines `[start, end)` and the changes to it that must be merged together. */
interface Group {
  readonly start: number;
  readonly end: number;
  readonly hunks: readonly SideHunk[];
}

/**
 * Whether two changes from different sides touch the same base lines.
 * Changes to neighbouring lines do not, and neither does an insertion just
 * before or after a line the other side changed: their order is plain.
 * Two different insertions at the same place do: which comes first is a choice.
 */
function overlap(a: Hunk, b: Hunk): boolean {
  const empty = (h: Hunk) => h.start === h.end;
  if (empty(a) && empty(b)) return a.start === b.start;
  if (empty(a)) return b.start < a.start && a.start < b.end;
  if (empty(b)) return a.start < b.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

/** Changes that overlap, directly or through another change, form one group. */
function groupHunks(hunks: readonly SideHunk[]): readonly Group[] {
  const parent = hunks.map((_, i) => i);
  const root = (i: number): number => (parent[i] === i ? i : root(parent[i]!));
  hunks.forEach((a, i) =>
    hunks.forEach((b, j) => {
      if (j > i && a.side !== b.side && overlap(a, b)) parent[root(j)] = root(i);
    }),
  );
  const members = new Map<number, SideHunk[]>();
  hunks.forEach((h, i) => members.set(root(i), [...(members.get(root(i)) ?? []), h]));
  return [...members.values()]
    .map((hs) => ({ start: Math.min(...hs.map((h) => h.start)), end: Math.max(...hs.map((h) => h.end)), hunks: hs }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

/** One side's version of base lines `[group.start, group.end)`: base with that side's changes in the group applied. */
function sideVersion(base: readonly string[], group: Group, side: 0 | 1): readonly string[] {
  const out: string[] = [];
  let at = group.start;
  for (const h of group.hunks.filter((x) => x.side === side).sort((a, b) => a.start - b.start)) {
    out.push(...base.slice(at, h.start), ...h.lines);
    at = h.end;
  }
  return [...out, ...base.slice(at, group.end)];
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}

/** Two different versions, with the lines they start and end with alike taken out as agreed, so only what differs is shown twice. */
function versions(first: readonly string[], second: readonly string[]): readonly MergedChunk[] {
  let head = 0;
  while (head < first.length && head < second.length && first[head] === second[head]) head++;
  let tail = 0;
  while (tail < first.length - head && tail < second.length - head && first[first.length - 1 - tail] === second[second.length - 1 - tail]) tail++;
  const chunks: MergedChunk[] = [
    { kind: "agreed", lines: first.slice(0, head) },
    { kind: "versions", first: first.slice(head, first.length - tail), second: second.slice(head, second.length - tail) },
    { kind: "agreed", lines: first.slice(first.length - tail) },
  ];
  return chunks.filter((c) => c.kind === "versions" || c.lines.length > 0);
}

/**
 * A three-way line merge of two versions of a text that share `base`. Changes
 * to different lines are all kept; where both sides changed the same lines
 * differently, the merge holds both versions for the caller to present.
 * The result depends only on the three texts, so whoever merges them gets the
 * same chunks. With no base (both sides wrote the text apart), the lines both
 * have in common stand in for it.
 */
export function mergeLines(base: readonly string[] | null, first: readonly string[], second: readonly string[]): readonly MergedChunk[] {
  const common = base ?? commonLines(first, second).map(([i]) => first[i]!);
  const hunks: SideHunk[] = [...diffLines(common, first).map((h) => ({ ...h, side: 0 as const })), ...diffLines(common, second).map((h) => ({ ...h, side: 1 as const }))];
  const chunks: MergedChunk[] = [];
  const agreed = (lines: readonly string[]) => {
    if (lines.length) chunks.push({ kind: "agreed", lines });
  };
  let at = 0;
  for (const group of groupHunks(hunks)) {
    agreed(common.slice(at, group.start));
    const [a, b] = [sideVersion(common, group, 0), sideVersion(common, group, 1)];
    const sides = new Set(group.hunks.map((h) => h.side));
    if (sides.size === 1) agreed(sides.has(0) ? a : b);
    else if (sameLines(a, b)) agreed(a);
    else chunks.push(...versions(a, b));
    at = group.end;
  }
  agreed(common.slice(at));
  return chunks;
}
