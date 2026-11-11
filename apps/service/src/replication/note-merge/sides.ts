import type { MachineRef } from "../seams.ts";

/** One side of a merge: a version of the file and the Machine it came from. */
export interface Side<T> {
  readonly value: T;
  readonly machine: MachineRef;
}

/** Orders Machines the same way on every Machine: by id, then name. A missing id sorts first. */
export function compareMachines(a: MachineRef, b: MachineRef): number {
  return compareText(a.id ?? "", b.id ?? "") || compareText(a.name, b.name);
}

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The two sides in an order that does not depend on which Machine is merging,
 * so every Machine that merges the same two versions writes the same file.
 */
export function inAgreedOrder<T>(ours: Side<T>, theirs: Side<T>): readonly [Side<T>, Side<T>] {
  return compareMachines(ours.machine, theirs.machine) <= 0 ? [ours, theirs] : [theirs, ours];
}
