import { describe, expect, it } from "vitest";
import { briefingLines } from "../src/briefing-text.ts";

describe("briefingLines", () => {
  it("puts each sentence on its own line", () => {
    expect(briefingLines("Two deadlines need attention. Nothing else changed.")).toEqual([
      { text: "Two deadlines need attention.", caveat: false },
      { text: "Nothing else changed.", caveat: false },
    ]);
  });

  it("keeps times, dates, issue numbers and abbreviations inside their sentence", () => {
    const lines = briefingLines("Trine moved the check-in to Fri 2026-10-09 10:30, e.g. after the stand-up. Two reviews remain open (beno#21 at 153 days, base#38 at 132 days).");
    expect(lines.map((l) => l.text)).toEqual(["Trine moved the check-in to Fri 2026-10-09 10:30, e.g. after the stand-up.", "Two reviews remain open (beno#21 at 153 days, base#38 at 132 days)."]);
  });

  it("splits before sentences that open with a quote, digit or emoji", () => {
    expect(briefingLines('Done. "TECH STATUS" was mentioned. 3 replies wait. 🐇 Prep is at 13:30.').map((l) => l.text)).toEqual(["Done.", '"TECH STATUS" was mentioned.', "3 replies wait.", "🐇 Prep is at 13:30."]);
  });

  it("marks coverage caveats so they can be shown quieter", () => {
    const lines = briefingLines("Reply to Puck today. The briefing may be incomplete because Slack returned an error. Incomplete: GitHub (partial) — items from these sources may be missing. Nothing is drafted, and Confluence coverage is only partial.");
    expect(lines.map((l) => l.caveat)).toEqual([false, true, true, true]);
  });

  it("returns nothing for blank text", () => {
    expect(briefingLines("  \n ")).toEqual([]);
  });
});
