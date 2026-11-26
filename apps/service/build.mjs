import { build, context } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A file next to this script, as a path esbuild accepts on every operating system. */
const here = (rel) => fileURLToPath(new URL(rel, import.meta.url));

const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const options = {
  entryPoints: [here("./src/main.ts")],
  outfile: here("./dist/attache-service.mjs"),
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: "linked",
  legalComments: "none",
  define: {
    "process.env.ATTACHE_VERSION": JSON.stringify(process.env.ATTACHE_VERSION ?? version),
    // The public key releases are signed with, a build input (ADR 0007): a constant in the bundle, so nothing at
    // run time can replace it. A bundle built without one (development, the browser journeys) checks no release.
    "process.env.ATTACHE_RELEASE_PUBLIC_KEY": process.env.ATTACHE_RELEASE_PUBLIC_KEY ? JSON.stringify(process.env.ATTACHE_RELEASE_PUBLIC_KEY) : "undefined",
    // Only the install test's release built to fail its health check (`build-release.mjs --fail-health-check`); every
    // other bundle has it as a constant too, so nothing at run time can turn it on.
    "process.env.ATTACHE_FAIL_HEALTH_CHECK": process.env.ATTACHE_FAIL_HEALTH_CHECK === "1" ? JSON.stringify("1") : "undefined",
  },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
};

/**
 * ONNX Runtime's WebAssembly build, which runs the meaning model, loads these
 * at run time from the bundle's own folder. They are the same on every platform.
 */
const ORT_RUNTIME_FILES = ["ort-wasm-simd-threaded.wasm", "ort-wasm-simd-threaded.mjs"];

function copyOrtRuntime() {
  const from = dirname(createRequire(import.meta.url).resolve("onnxruntime-web"));
  const to = fileURLToPath(new URL("./dist/", import.meta.url));
  mkdirSync(to, { recursive: true });
  for (const f of ORT_RUNTIME_FILES) copyFileSync(join(from, f), join(to, f));
}

copyOrtRuntime();
if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
  // The command each Harness runs from its hooks: small, so it starts fast inside a Harness hook budget.
  await build({ ...options, entryPoints: [here("./src/agents/attache-agent-hook.ts")], outfile: here("./dist/attache-agent-hook.mjs"), sourcemap: false, banner: {} });
  // Library entry for in-process probes (scripts/live-readonly.mjs); not shipped in releases.
  await build({ ...options, entryPoints: [here("./src/live-probe.ts")], outfile: here("./dist/live-probe.mjs"), sourcemap: false });
}
