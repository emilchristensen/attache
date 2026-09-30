#!/usr/bin/env node
/**
 * Release verification entry point. Runs every automated check, maps results to
 * the acceptance IDs A01–A15, and writes:
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

function step(id, name, cmd, args, opts = {}) {
  const started = Date.now();
  process.stdout.write(`\n▶ ${name}\n  $ ${[cmd, ...args].join(" ")}\n`);
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", env: { ...process.env, ...(opts.env ?? {}) }, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 30 * 60_000 });
  const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const status = r.status === 0 ? "pass" : opts.blockedIf?.(output) ? "blocked" : "fail";
  const rec = { ids: id, name, command: [cmd, ...args].join(" "), status, seconds: Math.round((Date.now() - started) / 100) / 10, tail: output.split("\n").filter(Boolean).slice(-15).join("\n"), ...(opts.extract ? opts.extract(output) : {}) };
  steps.push(rec);
  process.stdout.write(`  ${status.toUpperCase()} in ${rec.seconds}s${rec.summary ? ` — ${rec.summary}` : ""}\n`);
  if (status === "fail") process.stdout.write(rec.tail + "\n");
  return rec;
}

const npx = "npx";
step(["A01"], "Excluded platform check", process.execPath, ["scripts/check-excluded.mjs"]);
step(["A13"], "Lint (ESLint, zero warnings)", npx, ["eslint", ".", "--max-warnings", "0"]);
for (const pkg of ["packages/contracts", "apps/service", "apps/web", "apps/obsidian"]) step(["A13"], `Typecheck ${pkg}`, npx, ["tsc", "-p", `${pkg}/tsconfig.json`]);
step(["A13"], "Build service", process.execPath, ["apps/service/build.mjs"]);
step(["A13", "A12"], "Build web client", npx, ["vite", "build", "apps/web"]);
step(["A11", "A15"], "Build Obsidian plugin", process.execPath, ["apps/obsidian/build.mjs"]);
step(["A03", "A04", "A05", "A06", "A07", "A08", "A09", "A13"], "Unit, contract and integration tests (Vitest)", npx, ["vitest", "run", "--reporter=default", "--reporter=json", "--outputFile=test-results/vitest.json"], {
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
  step(["A02", "A15"], `Release artifacts ${version}`, process.execPath, ["scripts/build-release.mjs", "--version", version]);
  step(["A02"], `Release artifacts ${nextPatch} (upgrade target)`, process.execPath, ["scripts/build-release.mjs", "--version", nextPatch]);
  const e2e = step(["A05", "A07", "A08", "A09", "A10", "A11", "A12"], "Browser, voice and Obsidian journeys (Playwright, real Chrome and Obsidian)", npx, ["playwright", "test", "tests/e2e/journeys.spec.ts", "tests/e2e/voice.spec.ts", "tests/e2e/obsidian.spec.ts", "tests/e2e/visual.spec.ts"], {
    env: { JARVIS_E2E_REBUILD_WEB: "0" },
    extract: () => {
      try {
        const j = JSON.parse(readFileSync(join(OUT, "e2e-results.json"), "utf8"));
        const specs = [];
        const walk = (s) => {
          for (const x of s.suites ?? []) walk(x);
          for (const sp of s.specs ?? []) specs.push({ file: sp.file, title: sp.title, status: sp.tests?.[0]?.results?.at(-1)?.status ?? (sp.tests?.[0]?.status === "skipped" ? "skipped" : "unknown") });
        };
        for (const s of j.suites) walk(s);
        const by = (f) => specs.filter((s) => s.file.includes(f));
        const count = (xs, st) => xs.filter((x) => x.status === st).length;
        return {
          summary: `${count(specs, "passed")}/${specs.length} passed, ${count(specs, "skipped")} skipped`,
          suites: Object.fromEntries(["journeys", "voice", "obsidian", "visual"].map((n) => [n, { passed: count(by(n), "passed"), skipped: count(by(n), "skipped"), total: by(n).length }])),
          specs,
        };
      } catch {
        return {};
      }
    },
  });
  if (e2e.suites) {
    for (const s of Object.values(e2e.suites)) if (s.skipped && !s.passed) e2e.status = e2e.status === "pass" ? "blocked" : e2e.status;
  }
  step(["A02", "A14"], "Install, reinstall, upgrade, backup/restore, uninstall (clean profile)", process.execPath, ["scripts/test-install.mjs", "--from", version, "--to", nextPatch], {
    extract: (out) => ({ summary: /(\d+\/\d+) installation checks passed/.exec(out)?.[1] ?? "" }),
  });
}

// Live, read-only results are separate and informational.
let live = null;
if (!QUICK) {
  step(["A06-live"], "Live read-only connection checks (real accounts, informational)", process.execPath, ["scripts/live-readonly.mjs"]);
  try {
    live = JSON.parse(readFileSync(join(OUT, "live-results.json"), "utf8"));
  } catch {
    live = null;
  }
}

const ACCEPTANCE = {
  A01: "Inspection/architecture docs + excluded-platform check",
  A02: "Clean install from artifact, idempotent reinstall, upgrade preserves config/data",
  A03: "Notes-only onboarding, persistence across restart, dependency errors",
  A04: "Disable/re-enable effects, disconnect and retention choices",
  A05: "Source-linked recall, citation locates evidence, corrections change answers",
  A06: "Adapter contract tests (auth, scope, pagination, retry, empty, partial, disconnect)",
  A07: "Dismissed items stay dismissed, changes resurface, failed sources visible",
  A08: "Durable jobs, reconnection replay, restart recovery, retry/cancel outcomes",
  A09: "Draft/approval enforcement, replay protection, verified receipts",
  A10: "Real voice input/output, interruption, denied microphone, typed chat during work",
  A11: "Built Obsidian plugin in a real test vault",
  A12: "Browser journeys incl. keyboard, narrow screen, reconnection, console errors",
  A13: "Lint, typecheck, build, behavioural tests",
  A14: "Backup/restore to fresh profile, upgrade, data-preserving uninstall, brains intact",
  A15: "Docs, artifacts, plugin assets, acceptance report",
};
const rollup = Object.fromEntries(
  Object.keys(ACCEPTANCE).map((id) => {
    const related = steps.filter((s) => s.ids.includes(id));
    const status = !related.length ? (id === "A15" ? "see docs" : "not run") : related.some((s) => s.status === "fail") ? "fail" : related.some((s) => s.status === "blocked") ? "blocked" : "pass";
    return [id, { status, checks: related.map((s) => `${s.name}: ${s.status}${s.summary ? ` (${s.summary})` : ""}`) }];
  }),
);
const docs = ["README.md", "docs/architecture.md", "docs/inspection.md", "docs/user-guide.md", "docs/developer-guide.md", "docs/build-status.md", "docs/acceptance-report.md"];
const missingDocs = docs.filter((d) => !existsSync(join(ROOT, d)));
const artifacts = [`release/${version}/Jarvis-Installer-${version}-macos-arm64.command`, `release/${version}/jarvis-${version}-macos-arm64.tar.gz`, `release/${version}/jarvis-obsidian-plugin-${version}.zip`, `release/${version}/SHA256SUMS`];
const missingArtifacts = artifacts.filter((a) => !existsSync(join(ROOT, a)));
rollup.A15 = { status: missingDocs.length || missingArtifacts.length ? "fail" : "pass", checks: [`docs present: ${docs.length - missingDocs.length}/${docs.length}${missingDocs.length ? ` (missing ${missingDocs.join(", ")})` : ""}`, `artifacts present: ${artifacts.length - missingArtifacts.length}/${artifacts.length}${missingArtifacts.length ? ` (missing ${missingArtifacts.join(", ")})` : ""}`] };
if (QUICK) for (const id of ["A02", "A10", "A11", "A12", "A14"]) if (rollup[id].status === "not run" || rollup[id].status === "pass") rollup[id] = { ...rollup[id], status: rollup[id].checks.length ? rollup[id].status : "not run" };

const report = { version, at: new Date().toISOString(), quick: QUICK, host: { platform: process.platform, arch: process.arch, node: process.version }, steps, acceptance: rollup, live };
writeFileSync(join(OUT, "verification-report.json"), JSON.stringify(report, null, 2));
const md = [
  `# Verification summary — Jarvis ${version}`,
  "",
  `Run at ${report.at} on ${process.platform}/${process.arch}, ${process.version}.${QUICK ? " Quick mode: release, install and platform suites skipped." : ""}`,
  "",
  "| ID | Status | Requirement | Checks |",
  "| --- | --- | --- | --- |",
  ...Object.entries(rollup).map(([id, r]) => `| ${id} | ${r.status} | ${ACCEPTANCE[id]} | ${r.checks.join("<br>")} |`),
  "",
  "## Steps",
  "",
  "| Status | Seconds | Step | Command |",
  "| --- | --- | --- | --- |",
  ...steps.map((s) => `| ${s.status} | ${s.seconds} | ${s.name}${s.summary ? ` (${s.summary})` : ""} | \`${s.command}\` |`),
  "",
  "## Live read-only results (separate from automated evidence)",
  "",
  ...(live ? live.results.map((r) => `- ${r.kind}: ${r.ok === true ? "passed" : r.ok === false ? "failed" : r.status}${r.account ? ` as ${r.account}` : ""}${r.coverage ? `, coverage ${r.coverage}` : ""}${r.scopes ? ` (${r.scopes.map((s) => `${s.scope}: ${s.items}`).join("; ")})` : ""}${r.note ? ` — ${r.note}` : ""}`) : ["- not run"]),
  "",
].join("\n");
writeFileSync(join(OUT, "verification-summary.md"), md);
const failed = Object.entries(rollup).filter(([, r]) => r.status === "fail").map(([id]) => id);
const blocked = Object.entries(rollup).filter(([, r]) => r.status === "blocked" || r.status === "not run").map(([id]) => id);
console.log(`\n${md}`);
console.log(`\nAcceptance: ${Object.values(rollup).filter((r) => r.status === "pass").length}/${Object.keys(rollup).length} pass${failed.length ? `, failing: ${failed.join(", ")}` : ""}${blocked.length ? `, blocked/not run: ${blocked.join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
