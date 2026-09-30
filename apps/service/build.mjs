import { build, context } from "esbuild";
import { readFileSync } from "node:fs";

const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const options = {
  entryPoints: [new URL("./src/main.ts", import.meta.url).pathname],
  outfile: new URL("./dist/jarvis-service.mjs", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: "linked",
  legalComments: "none",
  define: { "process.env.JARVIS_VERSION": JSON.stringify(process.env.JARVIS_VERSION ?? version) },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
