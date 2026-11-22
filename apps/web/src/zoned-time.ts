/**
 * Wall-clock arithmetic in a named time zone, from instants. The Dashboard stores and compares instants only; these
 * helpers find "noon on that day" or "midnight after it" in whatever zone the browser is in now, daylight saving
 * included, so a laptop that travels or wakes in another zone gets the right answer.
 */

export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();

function wallFormat(timeZone: string): Intl.DateTimeFormat {
  const known = formats.get(timeZone);
  if (known) return known;
  const made = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
  formats.set(timeZone, made);
  return made;
}

/** The wall time an instant shows in `timeZone`. */
export function wallTime(at: number, timeZone: string): WallTime {
  const parts = Object.fromEntries(wallFormat(timeZone).formatToParts(at).map((p) => [p.type, p.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute) };
}

function asUtc(w: WallTime): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
}

/**
 * The instant a wall time names in `timeZone`. A wall time skipped by a daylight-saving jump gives the instant just
 * after the jump; one that happens twice gives the first.
 */
export function instantOf(w: WallTime, timeZone: string): number {
  const wanted = asUtc(w);
  // The zone's offset at a few hours either side of the guess covers every daylight-saving jump.
  const candidates = [-12, 0, 12].map((h) => {
    const near = wanted + h * 3_600_000;
    return wanted - (asUtc(wallTime(near, timeZone)) - near);
  });
  const exact = candidates.filter((c) => asUtc(wallTime(c, timeZone)) === wanted);
  return exact.length ? Math.min(...exact) : Math.max(...candidates);
}

/** Midnight at the start of the day `days` after the local day of `at` (0 = that day). */
export function startOfDay(at: number, timeZone: string, days = 0): number {
  const w = wallTime(at, timeZone);
  const shifted = new Date(Date.UTC(w.year, w.month - 1, w.day + days));
  return instantOf({ year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour: 0, minute: 0 }, timeZone);
}

/** A time of day ("08:00", 24-hour) on the local day of `at`. */
export function atTimeOfDay(at: number, timeZone: string, hhmm: string): number {
  const [hour, minute] = hhmm.split(":").map(Number) as [number, number];
  return instantOf({ ...wallTime(startOfDay(at, timeZone), timeZone), hour, minute }, timeZone);
}

/** "2026-11-18": the local day of an instant in `timeZone`, as a key that sorts and compares like the day. */
export function dayKey(at: number, timeZone: string): string {
  const w = wallTime(at, timeZone);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

/** Whether an instant falls on a Saturday or Sunday in `timeZone`. */
export function isWeekend(at: number, timeZone: string): boolean {
  const w = wallTime(at, timeZone);
  const weekday = new Date(Date.UTC(w.year, w.month - 1, w.day)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/** Whether two instants fall on the same local day. */
export function sameDay(a: number, b: number, timeZone: string): boolean {
  return startOfDay(a, timeZone) === startOfDay(b, timeZone);
}

/** "08:02": the 24-hour clock time an instant shows in `timeZone`. */
export function clockTime(at: number, timeZone: string): string {
  const w = wallTime(at, timeZone);
  return `${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
}

/**
 * When something happened, against `now`: "at 08:02" today, "yesterday at 23:10", or "on 16 November at 09:00", so an
 * older time is never read as today's.
 */
export function spokenTime(at: number, now: number, timeZone: string): string {
  if (sameDay(at, now, timeZone)) return `at ${clockTime(at, timeZone)}`;
  if (startOfDay(now, timeZone, -1) === startOfDay(at, timeZone)) return `yesterday at ${clockTime(at, timeZone)}`;
  const date = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "long" }).format(at);
  return `on ${date} at ${clockTime(at, timeZone)}`;
}
