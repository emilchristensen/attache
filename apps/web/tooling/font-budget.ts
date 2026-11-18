import type { Plugin } from "vite";

/**
 * The Dashboard ships its own typeface (Inter, Latin subset), so it looks the same on every Machine and never
 * fetches a font from the internet. This budget keeps that face from growing the bundle: the build fails above it.
 */
export const FONT_BUDGET_BYTES = 150_000;

const FONT_FILE = /\.(woff2?|ttf|otf)$/i;

export interface BuiltFile {
  fileName: string;
  size: number;
}

export interface FontMeasure {
  files: BuiltFile[];
  total: number;
  over: boolean;
  /** One line naming the total and every font file, for the build's error and log. */
  message: string;
}

const kb = (bytes: number) => `${(bytes / 1000).toFixed(1)} KB`;

/** The font files among a build's output, their total size, and whether that total is over the budget. */
export function measureFonts(built: BuiltFile[], budget = FONT_BUDGET_BYTES): FontMeasure {
  const files = built.filter((f) => FONT_FILE.test(f.fileName));
  const total = files.reduce((sum, f) => sum + f.size, 0);
  const over = total > budget;
  const list = files.map((f) => `${f.fileName} (${kb(f.size)})`).join(", ");
  const message = `Font files are ${kb(total)}, ${over ? "over" : "within"} the ${budget / 1000} KB budget${list ? `: ${list}` : ""}.`;
  return { files, total, over, message };
}

/** Fails `vite build` when the emitted font files are over the budget. */
export function fontBudget(budget = FONT_BUDGET_BYTES): Plugin {
  return {
    name: "attache-font-budget",
    apply: "build",
    generateBundle(_options, bundle) {
      const built = Object.values(bundle).map((f) => ({ fileName: f.fileName, size: f.type === "asset" ? byteLength(f.source) : byteLength(f.code) }));
      const fonts = measureFonts(built, budget);
      if (fonts.over) this.error(fonts.message);
      this.info(fonts.message);
    },
  };
}

function byteLength(source: string | Uint8Array): number {
  return typeof source === "string" ? new TextEncoder().encode(source).length : source.byteLength;
}
