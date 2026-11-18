import { describe, expect, it } from "vitest";
import { atTimeOfDay, spokenTime, startOfDay } from "../src/zoned-time.ts";

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
});
