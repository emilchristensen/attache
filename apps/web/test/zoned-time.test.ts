import { describe, expect, it } from "vitest";
import { atTimeOfDay, dayKey, isWeekend, spokenTime, startOfDay } from "../src/zoned-time.ts";

describe("zoned time", () => {
  it("finds the start of a day whose midnight a daylight-saving jump skips", () => {
    // Santiago moves its clocks from 00:00 to 01:00 on 6 September 2026: the day starts at 01:00 (-03:00).
    const noon = Date.parse("2026-09-06T15:00:00Z");
    expect(new Date(startOfDay(noon, "America/Santiago")).toISOString()).toBe("2026-09-06T04:00:00.000Z");
  });

  it("picks the first of a wall time that happens twice", () => {
    // Copenhagen goes back from 03:00 to 02:00 on 25 October 2026; 02:30 first happens at 00:30 UTC.
    expect(new Date(atTimeOfDay(Date.parse("2026-10-25T10:00:00Z"), "Europe/Copenhagen", "02:30")).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  it("names the day when it is not today", () => {
    const now = Date.parse("2026-11-18T10:00:00Z");
    expect(spokenTime(Date.parse("2026-11-18T07:02:00Z"), now, "Europe/Copenhagen")).toBe("at 08:02");
    expect(spokenTime(Date.parse("2026-11-17T22:10:00Z"), now, "Europe/Copenhagen")).toBe("yesterday at 23:10");
    expect(spokenTime(Date.parse("2026-11-16T08:00:00Z"), now, "Europe/Copenhagen")).toBe("on 16 November at 09:00");
  });

  it.each([
    ["2026-11-18T22:30:00Z", "Europe/Copenhagen", "2026-11-18T23:30 in Copenhagen", "2026-11-18"],
    ["2026-11-18T23:30:00Z", "Europe/Copenhagen", "00:30 the next day in Copenhagen", "2026-11-19"],
    ["2026-11-19T03:00:00Z", "America/New_York", "22:00 the evening before in New York", "2026-11-18"],
  ])("names the local day of %s in %s (%s) as %s", (at, zone, _, key) => {
    expect(dayKey(Date.parse(at), zone)).toBe(key);
  });

  it.each([
    ["2026-11-20T22:59:00Z", false, "Friday 23:59 in Copenhagen"],
    ["2026-11-20T23:00:00Z", true, "Saturday 00:00 in Copenhagen"],
    ["2026-11-22T22:59:00Z", true, "Sunday 23:59 in Copenhagen"],
    ["2026-11-22T23:00:00Z", false, "Monday 00:00 in Copenhagen"],
  ])("tells whether %s falls on a weekend: %s (%s)", (at, weekend) => {
    expect(isWeekend(Date.parse(at), "Europe/Copenhagen")).toBe(weekend);
  });
});
