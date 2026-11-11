#!/usr/bin/env node
/**
 * LIVE, READ-ONLY connection checks, reported separately from fixture tests.
 * Uses sign-ins that already exist on this machine in a throwaway profile:
 * the GitHub CLI login, and the claude.ai connectors (Slack, Gmail, Google
 * Calendar, and Jira/Confluence through Atlassian Rovo) through the signed-in
 * Claude Code CLI. Jira and Confluence need the site in
 * JARVIS_LIVE_ATLASSIAN_SITE; with _EMAIL and _TOKEN an MCP-scoped API token is
 * used instead. It performs only reads and
 * deletes the profile afterwards. Services without a usable sign-in are
 * reported as "not configured", never as passed. Writes
 * test-results/live-results.json.
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
    const sync = await app.connections.refresh("github");
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
  const live = async (kind, method, fields, scopes) => {
    const { test } = await app.connections.configure(kind, { method, ...fields }, scopes);
    if (!test.ok) return { kind, mode: "live-read-only", ok: false, status: test.state, test: test.message, writes: 0 };
    const sync = await app.connections.refresh(kind);
    return {
      kind,
      mode: "live-read-only",
      ok: ["complete", "empty", "partial"].includes(sync.coverage.state),
      account: test.account,
      test: test.message,
      coverage: sync.coverage.state,
      scopes: sync.coverage.scopes.map((s) => ({ scope: s.scope, state: s.state, items: s.items, pages: s.pages, note: s.note ?? null })),
      attentionCreated: sync.attention.created.length,
      writes: 0,
    };
  };
  let claudeSignedIn = false;
  try {
    claudeSignedIn = JSON.parse(execFileSync("claude", ["auth", "status", "--json"], { encoding: "utf8" })).loggedIn === true;
  } catch {
    claudeSignedIn = false;
  }
  const claudeKinds = [
    ["slack", ["dms", "mentions"]],
    ["gmail", ["inbox_recent"]],
    ["gcal", ["upcoming"]],
  ];
  for (const [kind, scopes] of claudeKinds) {
    if (claudeSignedIn) results.push(await live(kind, "claude-ai", {}, scopes));
    else results.push({ kind, mode: "live-read-only", ok: null, status: "not_configured", note: "Claude Code is not signed in with a claude.ai account on this machine." });
  }
  const site = process.env.JARVIS_LIVE_ATLASSIAN_SITE;
  const email = process.env.JARVIS_LIVE_ATLASSIAN_EMAIL;
  const token = process.env.JARVIS_LIVE_ATLASSIAN_TOKEN;
  // Jira and Confluence: the claude.ai Atlassian Rovo connector when Claude Code is signed in, else an MCP-scoped token.
  for (const [kind, scopes] of [["jira", ["assigned_open", "due_soon"]], ["confluence", ["mentions", "my_recent"]]]) {
    if (site && email && token) results.push(await live(kind, "api-token", { siteUrl: site, email, apiToken: token }, scopes));
    else if (site && claudeSignedIn) results.push(await live(kind, "claude-ai", { siteUrl: site }, scopes));
    else results.push({ kind, mode: "live-read-only", ok: null, status: "not_configured", note: "Set JARVIS_LIVE_ATLASSIAN_SITE (with Claude Code signed in and the claude.ai Atlassian Rovo connector connected), or _SITE/_EMAIL/_TOKEN for an mcp-v2 API token. Contract tests cover the adapter." });
  }
} finally {
  await app.stop();
  rmSync(state, { recursive: true, force: true });
}
mkdirSync(join(ROOT, "test-results"), { recursive: true });
writeFileSync(join(ROOT, "test-results/live-results.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
console.log(JSON.stringify(results, null, 2));
