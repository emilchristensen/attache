import { describe, expect, it } from "vitest";
import { HUES } from "../src/theme/hues.ts";
import { contrast, readTokens, type Theme } from "./theme-tokens.ts";

/** WCAG 2.2 AA: 1.4.3 for text, 1.4.11 for icons, bars, input borders and the focus ring. */
const TEXT = 4.5;
const NON_TEXT = 3;

/** Opaque grounds that text and graphics sit on. */
const GROUNDS = ["--paper", "--side", "--surface", "--raised", "--sunken"];
const SOFTS = HUES.map((h) => `--${h}-soft`);

interface Pair {
  fore: string;
  back: string;
  /** What a translucent `back` is painted over. */
  base?: string;
  min: number;
}

const text = (fores: string[], backs: string[], base?: string): Pair[] => fores.flatMap((fore) => backs.map((back) => ({ fore, back, base, min: TEXT })));
const graphic = (fores: string[], backs: string[]): Pair[] => fores.flatMap((fore) => backs.map((back) => ({ fore, back, min: NON_TEXT })));

const PAIRS: Pair[] = [
  // Neutral text on every ground; meta text also on every tinted panel and group header.
  ...text(["--ink", "--ink-2", "--ink-3"], GROUNDS),
  ...text(["--ink", "--ink-2", "--ink-3"], SOFTS),
  // Text on a hovered or selected row.
  ...text(["--ink", "--ink-2", "--ink-3"], ["--row-hover", "--row-on"], "--surface"),
  // Links on every ground and on the indigo panel.
  ...text(["--accent"], [...GROUNDS, "--indigo-soft"]),
  ...text(["--on-accent"], ["--accent-solid"]),
  // The count beside the attention dot, and attention and danger tags.
  ...text(["--attn-ink"], ["--paper", "--surface", "--side"]),
  ...text(["--attn-ink"], ["--attn-soft"], "--surface"),
  ...text(["--danger"], ["--paper", "--surface", "--red-soft"]),
  // Each hue: its word on its own tint and on the plain grounds, and the on-colour on its solid tile.
  ...HUES.flatMap((h) => text([`--${h}-ink`], [`--${h}-soft`, "--surface", "--paper"])),
  ...HUES.flatMap((h) => text(["--on-c"], [`--${h}`])),
  // Graphics: hue solids, input borders, the primary button and switch, the focus ring, the attention dot.
  ...HUES.flatMap((h) => graphic([`--${h}`], ["--surface", "--paper"])),
  ...graphic(["--line-strong"], ["--paper", "--surface", "--side"]),
  ...graphic(["--accent-solid", "--accent"], ["--paper", "--surface", "--side"]),
  ...graphic(["--attn"], ["--paper", "--surface", "--side"]),
];

describe("contrast", () => {
  it("measures the WCAG ratio", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    // Half-transparent black over white is mid grey (#808080, 3.95:1 against white).
    expect(contrast("#ffffff", "rgba(0, 0, 0, 0.5)", "#ffffff")).toBeCloseTo(3.95, 1);
  });
});

describe.each<Theme>(["light", "dark"])("the %s theme", (theme) => {
  const tokens = readTokens(theme);
  const value = (name: string) => {
    const v = tokens.get(name);
    if (v === undefined) throw new Error(`${name} is not set in the ${theme} theme`);
    return v;
  };

  it.each(HUES)("sets all four steps of %s", (hue) => {
    for (const step of ["", "-ink", "-soft", "-line"]) expect(tokens.has(`--${hue}${step}`), `--${hue}${step}`).toBe(true);
  });

  it.each(PAIRS.map((p) => [`${p.fore} on ${p.back} reaches ${p.min}:1`, p] as const))("%s", (_, p) => {
    const ratio = contrast(value(p.fore), value(p.back), value(p.base ?? "--paper"));
    expect(ratio, `${p.fore} ${value(p.fore)} on ${p.back} ${value(p.back)}`).toBeGreaterThanOrEqual(p.min);
  });
});
