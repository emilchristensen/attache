import { z } from "zod";

/** The Machine that wrote a part of the review state. */
export const ReviewMachine = z.object({ id: z.string().nullable(), name: z.string() });
export type ReviewMachine = z.infer<typeof ReviewMachine>;

/** What every recorded decision has: when, and on which Machine. */
export interface TimedDecision {
  id: string;
  at: string;
  machine: ReviewMachine;
}

/**
 * Order decisions oldest first: by time, a tie broken by Machine id (a
 * missing id loses), then by the decision's own id, so every Machine picks
 * the same latest decision.
 */
export function decisionOrder(a: TimedDecision, b: TimedDecision): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1;
  const ai = a.machine.id;
  const bi = b.machine.id;
  if (ai !== bi) {
    if (ai === null) return -1;
    if (bi === null) return 1;
    return ai < bi ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The decision that stands: the latest one. */
export function latestDecision<T extends TimedDecision>(decisions: readonly T[]): T | null {
  return [...decisions].sort(decisionOrder).at(-1) ?? null;
}

/** Both sides' decisions, each once, oldest first. */
export function mergeDecisions<T extends TimedDecision>(a: readonly T[], b: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const d of [...a, ...b]) if (!byId.has(d.id)) byId.set(d.id, d);
  return [...byId.values()].sort(decisionOrder);
}
