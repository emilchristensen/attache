import type { HeadsUp } from "./heads-ups.ts";

/**
 * For you now's fixed rules, as named constants: when each Heads-up kind applies and leaves, how often the slot is
 * computed again, how many followers show and each kind's urgency. `heads-ups.ts` re-exports them.
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
/** The daily briefing leads until this time of day, in the current zone on the briefing's day. */
export const DAILY_BRIEFING_UNTIL = "12:00";
/** How long an away summary or a briefing the owner asked for stays, from when it was made. */
export const REQUESTED_BRIEFING_STAYS_MS = 4 * HOUR_MS;
/** How often the slot is computed again; it is also computed again when the page becomes visible. */
export const HEADS_UP_TICK_MS = MINUTE_MS;
/** Followers shown under the lead; any further ones open from a disclosure, in order. */
export const VISIBLE_FOLLOWERS = 2;
/** Meeting prep shows from this long before the meeting starts until its scheduled end. */
export const MEETING_LEAD_MS = 15 * MINUTE_MS;

/**
 * Urgency, most urgent first: a kind's place in the order. Within one rank, Heads-ups go by their time, then key.
 * Meeting prep (#26 of spec #14) takes `meeting`, so a meeting in progress, then the next one, come before briefings.
 */
export const RANK = { meeting: 10, briefing: 20, progress: 30, earlier: 40 } as const;

/** The order of Heads-ups: by rank, then the instant each is about, then its key. */
export function byUrgency(a: HeadsUp, b: HeadsUp): number {
  return a.rank - b.rank || a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
