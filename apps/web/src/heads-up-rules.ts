/**
 * Home's fixed time rules, as named constants, shared by For you now (`for-you-now.ts`), Your day (`your-day.ts`),
 * The Daily Briefing and Home's clock (`heads-up-clock.ts`), so one rule has one value everywhere.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
/** How long an away summary or a briefing the owner asked for stays above the Daily Briefing, from when it was made. */
export const REQUESTED_BRIEFING_STAYS_MS = 4 * HOUR_MS;
/** How often Home's clock reads the time again; it is also read again when the page becomes visible. */
export const HEADS_UP_TICK_MS = MINUTE_MS;
/**
 * Meeting prep is in For you now, and Join shows in Your day, from this long before a meeting starts until its
 * scheduled end.
 */
export const MEETING_LEAD_MS = 15 * MINUTE_MS;
