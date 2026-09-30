/**
 * Draft expiry counts business hours only: Saturday and Sunday are skipped
 * entirely.
 */
export const DRAFT_BUSINESS_HOURS = 48;

export function addBusinessHours(start: Date, hours: number): Date {
  const t = new Date(start.getTime());
  let remaining = hours;
  // Each hour counts by the day it starts on; weekend time is skipped entirely.
  while (remaining > 0) {
    if (isWeekend(t)) {
      t.setUTCHours(24, 0, 0, 0);
      continue;
    }
    t.setTime(t.getTime() + 3_600_000);
    remaining--;
  }
  return t;
}

function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}
