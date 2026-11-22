import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { decode } from "jpeg-js";
import { describe, expect, it } from "vitest";
import { PAINTINGS, paintingForDate } from "../src/paintings.ts";
import { linear, LUMA, luminance, over, parseColour, readTokens, type Theme } from "./theme-tokens.ts";

const PUBLIC = join(import.meta.dirname, "../public");
/** WCAG 2.2 AA for text. */
const TEXT = 4.5;
/** Each shipped painting stays small, so the Dashboard's bundle stays small. */
const MAX_BYTES = 150 * 1024;

/**
 * The lowest contrast `fore` has over any pixel of a painting under `scrim`: any crop can put any pixel behind the
 * words, so the lightest composite of the whole image is the one that counts.
 */
function worstContrast(src: string, fore: string, scrim: string): number {
  const image = decode(readFileSync(join(PUBLIC, src)), { useTArray: true, formatAsRGBA: true });
  const top = parseColour(scrim);
  // Luminance adds up the three channels, so each channel's share under the scrim is looked up by its value.
  const mixed = Array.from({ length: 256 }, (_, v) => over(top, { r: v, g: v, b: v, a: 1 }));
  const [r, g, b] = (["r", "g", "b"] as const).map((c) => mixed.map((m) => LUMA[c] * linear(m[c]))) as [number[], number[], number[]];
  let lightest = 0;
  for (let i = 0; i < image.data.length; i += 4) lightest = Math.max(lightest, r[image.data[i]!]! + g[image.data[i + 1]!]! + b[image.data[i + 2]!]!);
  return (luminance(parseColour(fore)) + 0.05) / (lightest + 0.05);
}

describe("briefing paintings", () => {
  it.each([
    ["2026-11-20", "2026-11-20"],
    ["2026-01-01", "2026-01-01"],
  ])("chooses the same painting for %s on every Machine", (date, again) => {
    expect(paintingForDate(date)).toEqual(paintingForDate(again));
  });

  it("chooses another painting the next day", () => {
    expect(paintingForDate("2026-11-20").id).not.toBe(paintingForDate("2026-11-21").id);
    expect(paintingForDate("2026-12-31").id).not.toBe(paintingForDate("2027-01-01").id);
  });

  it("uses every painting over a week of days", () => {
    const week = Array.from({ length: PAINTINGS.length }, (_, n) => paintingForDate(`2026-11-${String(10 + n).padStart(2, "0")}`).id);
    expect(new Set(week).size).toBe(PAINTINGS.length);
  });

  it.each(PAINTINGS.map((p) => [p.id, p] as const))("ships %s with Attache, credited and small", (_, painting) => {
    expect(painting.src).toBe(`/paintings/${painting.id}.jpg`);
    expect(statSync(join(PUBLIC, painting.src)).size).toBeLessThanOrEqual(MAX_BYTES);
    expect(painting.title).not.toBe("");
    expect(painting.painter).not.toMatch(/public domain/i);
    expect(painting.source).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
    expect(painting.licence).toMatch(/^Public domain/);
    expect(painting.focal).toMatch(/^\d{1,3}% \d{1,3}%$/);
  });

  it.each(PAINTINGS.flatMap((p) => (["light", "dark"] as Theme[]).map((theme) => [p.id, theme, p.src] as const)))("gives the words 4.5:1 over every pixel of %s in the %s theme", (_, theme, src) => {
    const tokens = readTokens(theme);
    expect(worstContrast(src, tokens.get("--painting-text")!, tokens.get("--painting-scrim")!)).toBeGreaterThanOrEqual(TEXT);
  });
});
