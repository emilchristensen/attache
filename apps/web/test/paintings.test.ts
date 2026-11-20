import { describe, expect, it } from "vitest";
import { PAINTINGS, paintingForDate } from "../src/paintings.ts";

const luminance = (hex: string) => {
  const values = hex.match(/[\da-f]{2}/gi)!.map((part) => parseInt(part, 16) / 255).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
};

describe("briefing paintings", () => {
  it("chooses the same painting for a date on every Machine", () => {
    expect(paintingForDate("2026-11-20")).toEqual(paintingForDate("2026-11-20"));
    expect(paintingForDate("2026-11-20").id).not.toBe(paintingForDate("2026-11-21").id);
  });

  it("gives text 4.5:1 over every shipped painting's lightest possible crop", () => {
    const white = luminance("ffffff");
    const overlay = luminance("000000");
    const ratio = (white + 0.05) / (overlay + 0.05);
    expect(PAINTINGS.map((painting) => painting.src)).toEqual(expect.arrayContaining(["/paintings/coast.svg", "/paintings/field.svg", "/paintings/garden.svg"]));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
