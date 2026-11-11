import { build, context } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A file next to this script, as a path esbuild accepts on every operating system. */
const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const options = {
  entryPoints: [here("./src/main.ts")],
  outfile: here("./dist/jarvis-service.mjs"),
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
  // The command coding agents run from their hooks: small, so it starts fast inside an agent's hook budget.
  await build({ ...options, entryPoints: [here("./src/agents/jarvis-agent-hook.ts")], outfile: here("./dist/jarvis-agent-hook.mjs"), sourcemap: false, banner: {} });
  // Library entry for in-process probes (scripts/live-readonly.mjs); not shipped in releases.
  await build({ ...options, entryPoints: [here("./src/live-probe.ts")], outfile: here("./dist/live-probe.mjs"), sourcemap: false });
}
