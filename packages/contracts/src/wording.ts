/**
 * Wording the service and the Dashboard both put in front of the owner, kept
 * here so both say a thing the same way. Updates have their own: `update-wording.ts`.
 */

/** A count with its noun in the right number: `1 file`, `2 files`, `0 entries`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
