/** A count with its noun in the right number: `1 file`, `2 files`, `0 entries`. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
