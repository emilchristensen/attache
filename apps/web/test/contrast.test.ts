import { describe, expect, it } from "vitest";
import { HUES } from "../src/theme/hues.ts";
import { contrast, readTokens, type Theme } from "./theme-tokens.ts";

/** WCAG 2.2 AA: 1.4.3 for text, 1.4.11 for icons, control edges and the focus ring. */
const TEXT = 4.5;
const NON_TEXT = 3;

/**
 * The approved values from `docs/design/dashboard-blind-astra/DESIGN.md` (canvas, paper, ink, the feature spread and
 * the foreground pairs of its contrast table). The Dashboard ships exactly these.
 */
const APPROVED: Record<Theme, Record<string, string>> = {
  light: {
    "--canvas": "#f7f6ef",
    "--paper": "#fffef8",
    "--ink": "#192d32",
    "--ink-2": "#46595b",
    "--feature": "#f7dfaf",
    "--blue": "#164d84",
    "--focus": "#164d84",
    "--plum": "#713760",
    "--rust": "#8a3d22",
    "--green": "#215b48",
    "--key": "#204d57",
    "--line": "#798482",
  },
  dark: {
    "--canvas": "#192628",
    "--paper": "#202f32",
    "--ink": "#f6f3de",
    "--ink-2": "#c0d0c9",
    "--feature": "#43351e",
    "--blue": "#a1cdff",
    "--focus": "#a1cdff",
    "--plum": "#f2b6dc",
    "--rust": "#ffbb96",
    "--green": "#a4ddc0",
    "--key": "#b4ded9",
    "--line": "#91aaa3",
  },
};

/** The opaque surfaces text and controls sit on: the page, cards and fields, code and keys, the lead briefing. */
const SURFACES = ["--canvas", "--paper", "--sunken", "--feature"];
/** A stamp or tag tint behind its own hue. */
const SOFTS = HUES.map((h) => `--${h}-soft`);
/** Translucent row states, painted over the paper of a list. */
const ROW_STATES = ["--row-hover", "--row-on"];

interface Pair {
  fore: string;
  back: string;
  /** What a translucent `back` is painted over. */
  base?: string;
  min: number;
}

const text = (fores: string[], backs: string[], base?: string): Pair[] => fores.flatMap((fore) => backs.map((back) => ({ fore, back, base, min: TEXT })));
const graphic = (fores: string[], backs: string[], base?: string): Pair[] => fores.flatMap((fore) => backs.map((back) => ({ fore, back, base, min: NON_TEXT })));

const PAIRS: Pair[] = [
  // Text: every neutral on every surface, on every tint and on a hovered or selected row.
  ...text(["--ink", "--ink-2", "--ink-3"], SURFACES),
  ...text(["--ink", "--ink-2", "--ink-3"], SOFTS),
  ...text(["--ink", "--ink-2", "--ink-3"], ROW_STATES, "--paper"),
  // The selected Setup step: its words on the translucent highlight, over the canvas of Setup's left pane.
  ...text(["--ink", "--ink-2"], ["--highlight"], "--canvas"),
  // Links and the words of the attention count and of danger.
  ...text(["--link"], SURFACES),
  ...text(["--link"], ROW_STATES, "--paper"),
  ...text(["--attn-ink", "--danger"], SURFACES),
  // A list of places on the page itself (Settings' section list, the Brain's collections): its words and a named
  // warning on a hovered or chosen row over the canvas, and the warning on a hovered row of a narrow window's card.
  ...text(["--ink", "--ink-2", "--attn-ink"], ROW_STATES, "--canvas"),
  ...text(["--attn-ink"], ROW_STATES, "--paper"),
  // The silent-Reader banner under the masthead: danger words on the red tint.
  ...text(["--danger"], ["--red-soft"]),
  // The primary button's words on its solid ink, and the selected navigation entry.
  ...text(["--on-primary"], ["--primary"]),
  // Each hue: its kind word on its own stamp, on every surface and on a selected row.
  ...HUES.flatMap((h) => text([`--${h}`], [`--${h}-soft`, ...SURFACES])),
  ...HUES.flatMap((h) => text([`--${h}`], ["--row-on"], "--paper")),
  // Connections' rows sit on the canvas: an open or hovered row keeps its meta words and a problem's state word.
  ...text(["--ink", "--ink-2", "--ink-3"], ["--row-hover"], "--canvas"),
  ...(["amber", "red", "slate"] as const).flatMap((h) => text([`--${h}`], ["--row-hover"], "--canvas")),
  ...graphic(["--focus"], ["--row-hover"], "--canvas"),
  // Stamped glyphs: the 19 px icon on its tint.
  ...HUES.flatMap((h) => graphic([`--${h}`], [`--${h}-soft`])),
  // Control edges: the outline of a secondary button and the edge of a field, on every surface they sit on.
  ...graphic(["--line"], ["--canvas", "--paper", "--sunken"]),
  ...graphic(["--key"], SURFACES),
  // The edge of a field a form found a problem with, beside its message in the same red.
  ...graphic(["--danger"], ["--canvas", "--paper"]),
  // The primary button's fill against the surface around it.
  ...graphic(["--primary"], SURFACES),
  // The focus ring, offset outside the control, on every surface, tint and row state it can land on.
  ...graphic(["--focus"], [...SURFACES, ...SOFTS]),
  ...graphic(["--focus"], ROW_STATES, "--paper"),
  // The attention dot.
  ...graphic(["--attn"], SURFACES),
];

describe("contrast", () => {
  it("measures the WCAG ratio", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    // Half-transparent black over white is mid grey (#808080, 3.95:1 against white).
    expect(contrast("#ffffff", "rgba(0, 0, 0, 0.5)", "#ffffff")).toBeCloseTo(3.95, 1);
  });

  it("reproduces the design's own measurements", () => {
    expect(contrast("#192d32", "#f7f6ef")).toBeCloseTo(13.25, 1);
    expect(contrast("#46595b", "#f7dfaf")).toBeCloseTo(5.68, 1);
    expect(contrast("#91aaa3", "#202f32")).toBeCloseTo(5.6, 1);
  });
});

describe.each<Theme>(["light", "dark"])("the %s theme", (theme) => {
  const tokens = readTokens(theme);
  const value = (name: string) => {
    const v = tokens.get(name);
    if (v === undefined) throw new Error(`${name} is not set in the ${theme} theme`);
    return v;
  };

  it.each(Object.entries(APPROVED[theme]))("ships the approved %s", (name, approved) => {
    expect(value(name).toLowerCase()).toBe(approved);
  });

  it.each(HUES)("sets both steps of %s", (hue) => {
    for (const step of ["", "-soft"]) expect(tokens.has(`--${hue}${step}`), `--${hue}${step}`).toBe(true);
  });

  it.each(PAIRS.map((p) => [`${p.fore} on ${p.back} reaches ${p.min}:1`, p] as const))("%s", (_, p) => {
    const ratio = contrast(value(p.fore), value(p.back), value(p.base ?? "--paper"));
    expect(ratio, `${p.fore} ${value(p.fore)} on ${p.back} ${value(p.back)}`).toBeGreaterThanOrEqual(p.min);
  });
});
