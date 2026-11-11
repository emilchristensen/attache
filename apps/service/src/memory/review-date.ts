/**
 * A Review date is the day after which a fact should be checked again. Past
 * that day the fact stays in the Brain and is shown as unverified. Days are
 * calendar days in UTC, the same days the Brain dates its facts with.
 */

/** Today as the Brain writes a fact's date. */
export function factDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Whether a fact with this Review date should be shown as unverified: the day has passed. */
export function isPastReview(review: string | null | undefined, now: Date = new Date()): boolean {
  return !!review && review < factDay(now);
}

/** How a Harness, a search result or the session context marks a fact past its Review date. */
export function unverifiedLabel(review: string): string {
  return `unverified: Review date ${review} passed`;
}
