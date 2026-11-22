/**
 * Reads the colour tokens of `apps/web/src/styles/tokens.css` for both themes and measures WCAG contrast between them.
 * The stylesheet is the only copy of the values: the contrast test reads it, so a changed token is measured as shipped.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Theme = "light" | "dark";
export type Tokens = ReadonlyMap<string, string>;

const TOKENS_CSS = join(import.meta.dirname, "../src/styles/tokens.css");

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** The custom properties declared directly in `body` (one CSS block's contents), later ones winning. */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

/** The contents of the first `{ ... }` block after `from`, with nested blocks kept. */
function blockAfter(css: string, from: number): string {
  const open = css.indexOf("{", from);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error("tokens.css: unbalanced braces");
}

/**
 * Every token for one theme, with `var()` references resolved.
 * Light is every top-level `:root` block; dark is light with the `@media (prefers-color-scheme: dark)` block's `:root` on top.
 */
export function readTokens(theme: Theme, source = readFileSync(TOKENS_CSS, "utf8")): Tokens {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const darkAt = css.indexOf("@media (prefers-color-scheme: dark)");
  if (darkAt < 0) throw new Error("tokens.css: no dark theme block");
  const darkBlock = blockAfter(css, darkAt);
  const outside = css.slice(0, darkAt) + css.slice(css.indexOf(darkBlock, darkAt) + darkBlock.length + 1);
  const light = new Map<string, string>();
  for (const m of outside.matchAll(/(?:^|})\s*:root\s*\{/g)) for (const [k, v] of declarations(blockAfter(outside, m.index!))) light.set(k, v);
  const raw = theme === "light" ? light : new Map([...light, ...declarations(blockAfter(darkBlock, darkBlock.indexOf(":root")))]);
  const resolve = (value: string, seen: string[]): string =>
    value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
      if (seen.includes(name)) throw new Error(`tokens.css: ${name} refers to itself`);
      const v = raw.get(name);
      if (v === undefined) throw new Error(`tokens.css: ${name} is used but never set`);
      return resolve(v, [...seen, name]);
    });
  return new Map([...raw].map(([k, v]) => [k, resolve(v, [k])]));
}

export function parseColour(value: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value);
  if (hex) {
    const h = hex[1]!.length === 3 ? [...hex[1]!].map((c) => c + c).join("") : hex[1]!;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(value);
  if (rgba) return { r: Number(rgba[1]), g: Number(rgba[2]), b: Number(rgba[3]), a: rgba[4] === undefined ? 1 : Number(rgba[4]) };
  throw new Error(`Not a colour the contrast test can read: ${value}`);
}

/** A translucent colour painted over an opaque one. */
export function over(top: Rgba, below: Rgba): Rgba {
  const mix = (t: number, b: number) => t * top.a + b * (1 - top.a);
  return { r: mix(top.r, below.r), g: mix(top.g, below.g), b: mix(top.b, below.b), a: 1 };
}

/** How much each channel weighs in relative luminance (WCAG 2). */
export const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 } as const;

/** A channel value (0 to 255) as linear light. */
export function linear(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance({ r, g, b }: Rgba): number {
  return LUMA.r * linear(r) + LUMA.g * linear(g) + LUMA.b * linear(b);
}

/** WCAG 2 contrast ratio of two CSS colours (hex or rgb/rgba); translucent colours are painted over `--paper`'s colour first. */
export function contrast(fore: string, back: string, paper = "#ffffff"): number {
  const base = parseColour(paper);
  const bg = over(parseColour(back), base);
  const fg = over(parseColour(fore), bg);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
