/**
 * Days without a time zone. The service does not know which zone the owner's browser is in, so anything it keeps for
 * "today" covers today in every zone: from UTC-12 to UTC+14.
 */

const HOUR_MS = 60 * 60_000;

/** The largest offset any time zone has from UTC (UTC+14), the widest any local day can be away from the UTC one. */
export const WIDEST_ZONE_OFFSET_MS = 14 * HOUR_MS;

/** The longest a local day lasts: 25 hours, on the day the clocks go back. */
export const LONGEST_DAY_MS = 25 * HOUR_MS;

/**
 * An instant at or before the start of today in every time zone, for the instant `at`. Whatever the zone, the local day
 * that holds `at` began at most one local day earlier, so a read from `at` less the longest day misses no meeting of
 * today, including those of a zone behind UTC that is still on the day before UTC's.
 */
export function startOfTodayEverywhere(at: number): number {
  return at - LONGEST_DAY_MS;
}
