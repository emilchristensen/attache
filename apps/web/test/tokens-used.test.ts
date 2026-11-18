import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTokens, type Theme } from "./theme-tokens.ts";

const SRC = join(import.meta.dirname, "../src");

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : /\.(css|tsx?)$/.test(e.name) ? [join(dir, e.name)] : []));
}

const sources = files(SRC).map((path) => ({ path: path.slice(SRC.length + 1), text: readFileSync(path, "utf8") }));

/** Custom properties a stylesheet or a component sets for its own subtree (`--c` of a hue class, `--tabs-edge`). */
const scoped = (s: { path: string; text: string }) => (s.path === join("styles", "tokens.css") ? s.text.split("\n").filter((line) => line.startsWith(".c-")).join("\n") : s.text);
const local = new Set(sources.flatMap((s) => [...scoped(s).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!)));

describe.each<Theme>(["light", "dark"])("the %s theme", (theme) => {
  const tokens = readTokens(theme);

  it("sets every token the stylesheets and screens use", () => {
    const missing = sources.flatMap((s) => [...s.text.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]!).filter((name) => !tokens.has(name) && !local.has(name)).map((name) => `${s.path}: ${name}`));
    expect(missing).toEqual([]);
  });
});
