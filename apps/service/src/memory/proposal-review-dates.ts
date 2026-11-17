import type { MemorySaveItem } from "@attache/contracts";

/**
 * A Proposal's item as it is applied today. A Review date must come after the
 * day a fact is written, so one that passed while the Proposal waited cannot
 * be kept: it is dropped, the fact is written without one, and an event in the
 * note's History says which date went and why. The owner can give the fact a
 * new Review date with a later save. Asking for a new date instead would make a
 * one-click decision a form, and refusing would leave only Reject.
 */
export function withoutPassedReviewDates(item: MemorySaveItem, today: string): MemorySaveItem {
  const facts = item.facts ?? [];
  const passed = facts.filter((f) => f.review !== undefined && f.review <= today);
  if (!passed.length) return item;
  const kept = facts.map((f) => {
    if (f.review === undefined || f.review > today) return f;
    const { review: _passed, ...rest } = f;
    return rest;
  });
  const dropped = passed.map((f) => `Review date ${f.review} of "${f.subject}" dropped: it had passed when the Proposal was applied`);
  return { ...item, facts: kept, events: [...(item.events ?? []), ...dropped] } as MemorySaveItem;
}
