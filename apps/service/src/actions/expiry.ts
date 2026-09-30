/**
 * Draft expiry counts business hours only: Saturday and Sunday are skipped
 * entirely.
 */
export const DRAFT_BUSINESS_HOURS = 48;

export function addBusinessHours(start: Date, hours: number): Date {
  const t = new Date(start.getTime());
  let remaining = hours;
  // Move off a weekend first so the clock starts on the next business day.
  while (isWeekend(t)) t.setUTCHours(24, 0, 0, 0);
  while (remaining > 0) {
    t.setTime(t.getTime() + 3_600_000);
    if (!isWeekend(t)) remaining--;
    else t.setUTCHours(24 * (t.getUTCDay() === 6 ? 2 : 1), 0, 0, 0);
  }
  return t;
}

function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}
