/**
 * Line diffs for the three-way prose merge: which lines of a base version a
 * side replaced, and with what.
 */

/** One change a side made: base lines `[start, end)` replaced by `lines`. `start === end` is an insertion before base line `start`. */
export interface Hunk {
  readonly start: number;
  readonly end: number;
  readonly lines: readonly string[];
}

/** Above this many cells the longest common subsequence is not worked out, and the differing middle counts as one change. */
const MAX_CELLS = 4_000_000;

/** Pairs `[i, j]` of equal lines `a[i] === b[j]`, in order, forming a longest common subsequence. */
export function commonLines(a: readonly string[], b: readonly string[]): ReadonlyArray<readonly [number, number]> {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const prefix = Array.from({ length: head }, (_, i) => [i, i] as const);
  const suffix = Array.from({ length: tail }, (_, k) => [a.length - tail + k, b.length - tail + k] as const);
  return [...prefix, ...middle(a.slice(head, a.length - tail), b.slice(head, b.length - tail)).map(([i, j]) => [i + head, j + head] as const), ...suffix];
}

/** The longest common subsequence of two lists of lines, by dynamic programming over their lengths. */
function middle(a: readonly string[], b: readonly string[]): ReadonlyArray<readonly [number, number]> {
  const [n, m] = [a.length, b.length];
  if (!n || !m || (n + 1) * (m + 1) > MAX_CELLS) return [];
  const width = m + 1;
  // lengths[i * width + j]: the longest common subsequence of a[i..] and b[j..].
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] = a[i] === b[j] ? lengths[(i + 1) * width + j + 1]! + 1 : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    }
  }
  const pairs: Array<readonly [number, number]> = [];
  let [i, j] = [0, 0];
  while (i < n && j < m) {
    if (a[i] === b[j]) pairs.push([i++, j++]);
    else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) i++;
    else j++;
  }
  return pairs;
}

/** What `other` changed in `base`, as hunks in base order. */
export function diffLines(base: readonly string[], other: readonly string[]): readonly Hunk[] {
  const hunks: Hunk[] = [];
  let [i, j] = [0, 0];
  for (const [bi, oj] of [...commonLines(base, other), [base.length, other.length] as const]) {
    if (bi > i || oj > j) hunks.push({ start: i, end: bi, lines: other.slice(j, oj) });
    [i, j] = [bi + 1, oj + 1];
  }
  return hunks;
}
