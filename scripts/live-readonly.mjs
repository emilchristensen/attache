#!/usr/bin/env node
/**
 * LIVE, READ-ONLY connection checks, reported separately from fixture tests.
 * Uses credentials that already exist on this machine (currently the GitHub
 * CLI login) in a throwaway profile, performs only reads, and deletes the
 * profile afterwards. Services without available credentials are reported as
 * "not configured", never as passed. Writes test-results/live-results.json.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
process.env.JARVIS_CREDENTIAL_STORE = "file";
process.env.JARVIS_NO_NOTIFY = "1";
const { App } = await import(join(ROOT, "apps/service/dist/live-probe.mjs"));

const state = mkdtempSync(join(tmpdir(), "jarvis-live-"));
const app = new App({ stateDir: state, quiet: true, instance: "live-probe" });
const results = [];
try {
  let ghToken = null;
  try {
    ghToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    ghToken = null;
  }
  if (ghToken) {
    const { test } = await app.connections.configure("github", { method: "gh-cli" }, ["review_requests", "authored_prs", "assigned_issues"]);
    const sync = await app.connections.sync("github");
    results.push({
      kind: "github",
      mode: "live-read-only",
      ok: test.ok && ["complete", "empty", "partial"].includes(sync.coverage.state),
      account: test.account,
      test: test.message,
      coverage: sync.coverage.state,
      scopes: sync.coverage.scopes.map((s) => ({ scope: s.scope, state: s.state, items: s.items, pages: s.pages, note: s.note ?? null })),
      attentionCreated: sync.attention.created.length,
      writes: 0,
    });
  } else results.push({ kind: "github", mode: "live-read-only", ok: false, status: "not_configured", note: "No GitHub CLI login on this machine" });
  for (const kind of ["jira", "confluence", "slack", "gmail", "gcal"]) {
    results.push({ kind, mode: "live-read-only", ok: null, status: "not_configured", note: "No credentials were provided to Jarvis for this service; it stays visibly unconfigured. Contract tests cover the adapter." });
  }
} finally {
  await app.stop();
  rmSync(state, { recursive: true, force: true });
}
mkdirSync(join(ROOT, "test-results"), { recursive: true });
writeFileSync(join(ROOT, "test-results/live-results.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
console.log(JSON.stringify(results, null, 2));
