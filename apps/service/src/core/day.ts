/**
 * Days without a time zone. The service does not know which zone the owner's browser is in, so anything it keeps for
 * "today" covers today in every zone: from UTC-12 to UTC+14.
 */

const DAY_MS = 24 * 60 * 60_000;

/** The largest offset any time zone has from UTC (UTC+14), the widest any local day can be away from the UTC one. */
export const WIDEST_ZONE_OFFSET_MS = 14 * 60 * 60_000;

/**
 * An instant at or before the start of today in every time zone, for the instant `at`: UTC midnight of `at`'s UTC day,
 * less the widest zone offset. Any zone's today began at or after it, so a read from it misses no meeting of today.
 */
export function startOfTodayEverywhere(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS - WIDEST_ZONE_OFFSET_MS;
}
