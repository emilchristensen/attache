import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { FONT_BUDGET_BYTES, fontBudget, measureFonts } from "../tooling/font-budget.ts";

const WEB = join(import.meta.dirname, "..");

/** Builds the Dashboard as `pnpm build` does, with the font budget given, into a temporary folder. */
async function buildDashboard(budget: number): Promise<string> {
  const outDir = mkdtempSync(join(tmpdir(), "attache-font-budget-"));
  await build({ configFile: false, root: WEB, logLevel: "silent", plugins: [react(), fontBudget(budget)], build: { outDir, emptyOutDir: true } });
  return outDir;
}

describe("the font budget", () => {
  it("is 150 KB", () => {
    expect(FONT_BUDGET_BYTES).toBe(150_000);
  });

  it("adds up the font files and ignores everything else", () => {
    const fonts = measureFonts([
      { fileName: "assets/inter-latin-wght-normal-abc.woff2", size: 48_256 },
      { fileName: "assets/index-def.js", size: 400_000 },
      { fileName: "assets/index-ghi.css", size: 30_000 },
      { fileName: "assets/mono-x.woff", size: 1_000 },
      { fileName: "assets/other.ttf", size: 2_000 },
      { fileName: "assets/other.otf", size: 3_000 },
    ]);
    expect(fonts.total).toBe(54_256);
    expect(fonts.files.map((f) => f.fileName)).toEqual(["assets/inter-latin-wght-normal-abc.woff2", "assets/mono-x.woff", "assets/other.ttf", "assets/other.otf"]);
    expect(fonts.over).toBe(false);
  });

  it("passes at exactly the budget", () => {
    expect(measureFonts([{ fileName: "a.woff2", size: 150_000 }]).over).toBe(false);
  });

  it("fails one byte over, naming every font file and its size", () => {
    const fonts = measureFonts([
      { fileName: "assets/a.woff2", size: 100_000 },
      { fileName: "assets/b.woff2", size: 50_001 },
    ]);
    expect(fonts.over).toBe(true);
    expect(fonts.message).toBe("Font files are 150.0 KB, over the 150 KB budget: assets/a.woff2 (100.0 KB), assets/b.woff2 (50.0 KB).");
  });

  it("lets the Dashboard build, with Inter bundled as one font file", async () => {
    const out = await buildDashboard(FONT_BUDGET_BYTES);
    expect(readdirSync(join(out, "assets")).filter((f) => f.endsWith(".woff2"))).toEqual([expect.stringMatching(/^inter-latin-wght-normal-.*\.woff2$/)]);
  });

  it("fails the Dashboard build when the font files are over the budget", async () => {
    await expect(buildDashboard(40_000)).rejects.toThrow(/Font files are 48\.3 KB, over the 40 KB budget/);
  });
});
