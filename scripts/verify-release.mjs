#!/usr/bin/env node
/**
 * Release verification entry point. Runs every automated check and writes:
 *   test-results/verification-report.json
 *   test-results/verification-summary.md
 * Live (read-only, real-account) results are reported separately and never
 * count as automated passes. Platform checks that cannot run on this host are
 * reported as "blocked", never as passed.
 *
 *   pnpm verify            full run
 *   pnpm verify -- --quick skip release build, install and platform suites
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const QUICK = process.argv.includes("--quick");
const OUT = join(ROOT, "test-results");
mkdirSync(OUT, { recursive: true });
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const nextPatch = version.replace(/(\d+)$/, (m) => String(Number(m) + 1));
const steps = [];

function step(name, cmd, args, opts = {}) {
  const started = Date.now();
  process.stdout.write(`\n▶ ${name}\n  $ ${[cmd, ...args].join(" ")}\n`);
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...(opts.env ?? {}) }, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 30 * 60_000 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const status = r.status === 0 ? "pass" : opts.blockedIf?.(output) ? "blocked" : "fail";
  const rec = { name, command: [cmd, ...args].join(" "), status, seconds: Math.round((Date.now() - started) / 100) / 10, tail: output.split("\n").filter(Boolean).slice(-15).join("\n"), ...(opts.extract ? opts.extract(output) : {}) };
  steps.push(rec);
  process.stdout.write(`  ${status.toUpperCase()} in ${rec.seconds}s${rec.summary ? ` — ${rec.summary}` : ""}\n`);
  if (status === "fail") process.stdout.write(rec.tail + "\n");
  return rec;
}

const npx = "npx";
step("Docs check (one sentence per line, glossary terms)", process.execPath, ["scripts/check-docs.mjs"]);
step("Lint (ESLint, zero warnings)", npx, ["eslint", ".", "--max-warnings", "0"]);
for (const pkg of ["packages/contracts", "apps/service", "apps/web"]) step(`Typecheck ${pkg}`, npx, ["tsc", "-p", `${pkg}/tsconfig.json`]);
step("Build service", process.execPath, ["apps/service/build.mjs"]);
// Through the package's own script: vite is a dependency of apps/web and is not hoisted to the root.
step("Build Dashboard", "pnpm", ["--filter", "@attache/web", "run", "build"]);
step("Unit, contract and integration tests (Vitest)", npx, ["vitest", "run", "--reporter=default", "--reporter=json", "--outputFile=test-results/vitest.json"], {
  extract: () => {
    try {
      const j = JSON.parse(readFileSync(join(OUT, "vitest.json"), "utf8"));
      return { summary: `${j.numPassedTests}/${j.numTotalTests} tests in ${j.testResults?.length ?? "?"} files`, passed: j.numPassedTests, total: j.numTotalTests };
    } catch {
      return {};
    }
  },
});

if (!QUICK) {
  step(`Release artifacts ${version}`, process.execPath, ["scripts/build-release.mjs", "--version", version]);
  step(`Release artifacts ${nextPatch} (upgrade target)`, process.execPath, ["scripts/build-release.mjs", "--version", nextPatch]);
  const e2eExtract = (file) => () => {
    try {
      const j = JSON.parse(readFileSync(join(OUT, `e2e-${file}.json`), "utf8"));
      const specs = [];
      const walk = (s) => {
        for (const x of s.suites ?? []) walk(x);
        for (const sp of s.specs ?? []) specs.push({ title: sp.title, status: sp.tests?.[0]?.results?.at(-1)?.status ?? (sp.tests?.[0]?.status === "skipped" ? "skipped" : "unknown") });
      };
      for (const s of j.suites) walk(s);
      const passed = specs.filter((x) => x.status === "passed").length;
      const skipped = specs.filter((x) => x.status === "skipped").length;
      return { summary: `${passed}/${specs.length} passed${skipped ? `, ${skipped} skipped` : ""}`, passed, skipped, total: specs.length, specs };
    } catch {
      return {};
    }
  };
  const e2e = (name, file) => {
    const rec = step(name, npx, ["playwright", "test", `tests/e2e/${file}.spec.ts`, "--reporter=list,json"], { env: { ATTACHE_E2E_REBUILD_WEB: "0", PLAYWRIGHT_JSON_OUTPUT_NAME: join(OUT, `e2e-${file}.json`) }, extract: e2eExtract(file) });
    // A suite that skipped because its host requirement is missing is blocked validation, not a pass.
    if (rec.status === "pass" && rec.skipped && !rec.passed) rec.status = "blocked";
    return rec;
  };
  e2e("Browser journeys (real Chrome)", "journeys");
  e2e("Visual captures (light, dark, narrow)", "visual");
  step("Install, reinstall, upgrade, backup/restore, uninstall (clean profile)", process.execPath, ["scripts/test-install.mjs", "--from", version, "--to", nextPatch], {
    extract: (out) => ({ summary: /(\d+\/\d+) installation checks passed/.exec(out)?.[1] ?? "" }),
  });
}

// Live, read-only results are separate and informational.
let live = null;
if (!QUICK) {
  step("Live read-only connection checks (real accounts, informational)", process.execPath, ["scripts/live-readonly.mjs"]);
  try {
    live = JSON.parse(readFileSync(join(OUT, "live-results.json"), "utf8"));
  } catch {
    live = null;
  }
}

const artifacts = [`release/${version}/Attache-Installer-${version}-macos-arm64.command`, `release/${version}/attache-${version}-macos-arm64.tar.gz`, `release/${version}/SHA256SUMS`];
const missingArtifacts = QUICK ? [] : artifacts.filter((a) => !existsSync(join(ROOT, a)));

const report = { version, at: new Date().toISOString(), quick: QUICK, host: { platform: process.platform, arch: process.arch, node: process.version }, steps, missingArtifacts, live };
writeFileSync(join(OUT, "verification-report.json"), JSON.stringify(report, null, 2));
const md = [
  `# Verification summary — Attache ${version}`,
  "",
  `Run at ${report.at} on ${process.platform}/${process.arch}, ${process.version}.${QUICK ? " Quick mode: release, install and platform suites skipped." : ""}`,
  "",
  "| Status | Seconds | Step | Command |",
  "| --- | --- | --- | --- |",
  ...steps.map((s) => `| ${s.status} | ${s.seconds} | ${s.name}${s.summary ? ` (${s.summary})` : ""} | \`${s.command}\` |`),
  "",
  ...(missingArtifacts.length ? [`Missing release artifacts: ${missingArtifacts.join(", ")}`, ""] : []),
  "## Live read-only results (separate from automated evidence)",
  "",
  ...(live ? live.results.map((r) => `- ${r.kind}: ${r.ok === true ? "passed" : r.ok === false ? "failed" : r.status}${r.account ? ` as ${r.account}` : ""}${r.coverage ? `, coverage ${r.coverage}` : ""}${r.scopes ? ` (${r.scopes.map((s) => `${s.scope}: ${s.items}`).join("; ")})` : ""}${r.note ? ` — ${r.note}` : ""}`) : ["- not run"]),
  "",
].join("\n");
writeFileSync(join(OUT, "verification-summary.md"), md);
const failed = steps.filter((s) => s.status === "fail").map((s) => s.name);
const blocked = steps.filter((s) => s.status === "blocked").map((s) => s.name);
console.log(`\n${md}`);
console.log(`\nSteps: ${steps.filter((s) => s.status === "pass").length}/${steps.length} pass${failed.length ? `, failing: ${failed.join(", ")}` : ""}${blocked.length ? `, blocked: ${blocked.join(", ")}` : ""}${missingArtifacts.length ? `, missing artifacts: ${missingArtifacts.length}` : ""}`);
process.exit(failed.length || missingArtifacts.length ? 1 : 0);
