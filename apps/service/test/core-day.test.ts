import { describe, expect, it } from "vitest";
import { startOfTodayEverywhere } from "../src/core/day.ts";

/** The instant `zone`'s local day that holds `at` began, found by stepping back minute by minute to the date change. */
function localMidnight(at: number, zone: string): number {
  const date = (t: number) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(t);
  const today = date(at);
  let t = at - (at % 60_000);
  while (date(t - 60_000) === today) t -= 60_000;
  return t;
}

const ZONES = ["Pacific/Kiritimati", "Pacific/Auckland", "Asia/Tokyo", "Europe/Copenhagen", "UTC", "Atlantic/Azores", "America/Los_Angeles", "Pacific/Honolulu", "Etc/GMT+12", "Australia/Lord_Howe"];

describe("startOfTodayEverywhere", () => {
  it.each([
    ["just after UTC midnight, when zones behind UTC are still on yesterday", "2026-11-24T00:30:00Z"],
    ["late in the UTC day", "2026-11-24T23:30:00Z"],
    ["late on the day the clocks go back in Los Angeles, a 25-hour day", "2026-11-02T07:30:00Z"],
    ["late on the day the clocks go back in Copenhagen", "2026-10-25T22:50:00Z"],
  ])("is at or before the start of today in every zone %s", (_when, iso) => {
    const at = Date.parse(iso);
    for (const zone of ZONES) expect(startOfTodayEverywhere(at), zone).toBeLessThanOrEqual(localMidnight(at, zone));
  });

  it("reaches back no further than the longest local day", () => {
    const at = Date.parse("2026-11-24T00:30:00Z");
    expect(at - startOfTodayEverywhere(at)).toBeLessThanOrEqual(25 * 60 * 60_000);
  });
});
