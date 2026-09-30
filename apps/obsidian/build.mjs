import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const here = (p) => new URL(p, import.meta.url).pathname;
const version = JSON.parse(readFileSync(here("../../package.json"), "utf8")).version;
const out = here("./dist/jarvis-companion");
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [here("./src/main.ts")],
  outfile: `${out}/main.js`,
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  logLevel: "info",
});
const manifest = { ...JSON.parse(readFileSync(here("./manifest.json"), "utf8")), version };
writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
copyFileSync(here("./styles.css"), `${out}/styles.css`);
