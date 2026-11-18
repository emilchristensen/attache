/** Captures every view in light, dark and narrow layouts for visual review (test-results/screens). */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionStatus } from "../../packages/contracts/src/features.ts";
import { api } from "./browser.ts";
import { arriveMeetingCapture, buildAll, harnessSave, startStack, type Stack } from "./stack.ts";
import { inboxRow, openRow } from "./inbox.ts";

let stack: Stack;
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  buildAll();
  stack = await startStack();
});
test.afterAll(() => stack?.stop());

const runGit = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Work Mac", GIT_AUTHOR_EMAIL: "w@example.invalid", GIT_COMMITTER_NAME: "Work Mac", GIT_COMMITTER_EMAIL: "w@example.invalid" } });

/** The Replication card in every theme and width: off, up to date with two Machines, and blocked with its cause. */
async function replicationScreens(page: Page) {
  // The card is captured once the Machines list has loaded, in tall viewports so it fits in one capture.
  const capture = async (path: string, on: boolean) => {
    await page.goto(`${stack.url}/settings`);
    const card = page.getByRole("region", { name: "Replication" });
    if (on) await expect(card.locator(".machine-row").first()).toBeVisible();
    await page.waitForTimeout(300);
    await card.screenshot({ path });
  };
  const shoot = async (name: string) => {
    await page.setViewportSize({ width: 1360, height: 2000 });
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await capture(`test-results/screens/${scheme}-settings-replication-${name}.png`, name !== "off");
    }
    await page.setViewportSize({ width: 390, height: 2400 });
    await capture(`test-results/screens/narrow-settings-replication-${name}.png`, name !== "off");
    await page.setViewportSize({ width: 1360, height: 900 });
  };
  await shoot("off");
  const base = mkdtempSync(join(tmpdir(), "attache-visual-remote-"));
  const remote = join(base, "brain.git");
  runGit(base, "init", "--bare", "--quiet", "-b", "main", remote);
  await api(page, "POST", "/replication/setup", { remote });
  // Another Machine's record, as it would arrive from the repository.
  const other = "6b1f0c7e-2d4a-4c55-9a8e-1f2e3d4c5b6a";
  mkdirSync(join(stack.dataDir, "machines"), { recursive: true });
  writeFileSync(join(stack.dataDir, "machines", `${other}.json`), `${JSON.stringify({ id: other, name: "Work Mac", standby: true, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  await api(page, "PUT", "/replication/preferred-reader", { machine: other });
  await api(page, "POST", "/replication/check");
  await shoot("up-to-date");
  // Both Machines changed a file no merge rule settles.
  const clone = join(base, "work-mac");
  runGit(base, "clone", "--quiet", remote, clone);
  writeFileSync(join(clone, "plan.txt"), "from the Work Mac\n");
  runGit(clone, "add", "plan.txt");
  runGit(clone, "commit", "--quiet", "-m", "Work Mac: plan");
  runGit(clone, "push", "--quiet", "origin", "main");
  writeFileSync(join(stack.dataDir, "plan.txt"), "from the Home PC\n");
  await api(page, "POST", "/replication/check");
  await shoot("blocked");
  // The rest of the screens show a single Machine.
  await api(page, "POST", "/replication/off");
}

/**
 * A Setup step in light, dark and narrow, then back to the desktop light view the journey continues in.
 * Each capture is one window as tall as the step, so the sticky Back and Continue sit at its end, where the owner meets them.
 */
async function setupScreens(page: Page, step: string) {
  // A disclosure's chevron turns in 0.15 s.
  await page.waitForTimeout(250);
  const shoot = async (width: number, path: string) => {
    await page.setViewportSize({ width, height: 900 });
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width, height });
    await page.screenshot({ path });
  };
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await shoot(1360, `test-results/screens/${scheme}-setup-${step}.png`);
  }
  await shoot(390, `test-results/screens/narrow-setup-${step}.png`);
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
}

/** Pairing and service recovery, the compact centred form, in light, dark and narrow. */
async function compactScreens(page: Page, name: string) {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `test-results/screens/${scheme}-${name}.png` });
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: `test-results/screens/narrow-${name}.png`, fullPage: true });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
}

/**
 * A bad day for Home's Connections area, from the real answer with four sources changed: Slack signed out, Gmail
 * down, Google Calendar not reached while offline and Jira not read yet, so three rows show and one waits behind "1 more".
 */
async function routeBadDay(page: Page) {
  await page.route("**/api/v1/capabilities", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { connections: ConnectionStatus[] };
    const gh = body.connections.find((c) => c.kind === "github")!;
    const like = (kind: ConnectionStatus["kind"], label: string, extra: Partial<ConnectionStatus>): ConnectionStatus => ({ ...gh, id: kind, kind, label, ...extra });
    const changed = [
      like("slack", "Slack", { status: "needs_auth", lastError: "Slack is not connected in claude.ai" }),
      like("gmail", "Gmail", { status: "error", lastError: "The connector answered 503" }),
      like("gcal", "Google Calendar", { coverage: gh.coverage && { ...gh.coverage, state: "offline" } }),
      like("jira", "Jira", { coverage: null, lastSuccessAt: null }),
    ];
    body.connections = [...body.connections.filter((c) => !changed.some((x) => x.kind === c.kind)), ...changed];
    await route.fulfill({ response: res, json: body });
  });
}

/** Home's Connections area: the green line as the stack is, then the bad day with its first row and "1 more" open. */
async function homeConnectionsScreens(page: Page) {
  const area = page.getByRole("status", { name: "Connections" });
  const capture = async (path: string) => {
    await page.waitForTimeout(300);
    await area.screenshot({ path });
  };
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(stack.url);
    await expect(area).toContainText("All good");
    await capture(`test-results/screens/${scheme}-home-connections.png`);
  }
  await routeBadDay(page);
  const badDay = async (path: string) => {
    await page.goto(stack.url);
    await expect(area.locator(".conn-row")).toHaveCount(4);
    await area.locator(".conn-row-line").first().click();
    await area.getByText("1 more: not read yet").click();
    await capture(path);
  };
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await badDay(`test-results/screens/${scheme}-home-connections-problems.png`);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 844 });
  await badDay("test-results/screens/narrow-home-connections-problems.png");
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.unroute("**/api/v1/capabilities");
}

test("screens", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(stack.url);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByText("Enter the pairing code.")).toBeVisible();
  await compactScreens(page, "pair");
  await page.route("**/api/v1/session", (route) => route.abort());
  await page.reload();
  await expect(page.getByRole("heading", { name: "Attache service is not reachable" })).toBeVisible();
  await compactScreens(page, "service-unreachable");
  await page.unroute("**/api/v1/session");
  await page.goto(stack.pairUrl());
  await page.getByRole("textbox", { name: /Data folder/ }).fill(stack.dataDir);
  await page.getByRole("button", { name: "Use this folder" }).click();
  await expect(page.getByText("Preview this folder to see what Attache will create in it.")).toBeVisible();
  await setupScreens(page, "folder-problem");
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByText("Import an existing Markdown folder or Obsidian vault").click();
  await page.getByRole("textbox", { name: "Folder to import" }).fill(stack.vaultDir);
  await page.getByRole("button", { name: "Preview import" }).click();
  await page.getByText("Who is this for?").click();
  await setupScreens(page, "folder");
  const joinBrain = page.getByText("Already use Attache on another Machine?");
  await joinBrain.click();
  await page.getByRole("button", { name: "Join into this folder" }).click();
  await expect(page.getByText("Enter the repository your other Machine replicates to.")).toBeVisible();
  await page.waitForTimeout(250);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.locator(".join-brain").screenshot({ path: `test-results/screens/${scheme}-setup-join.png` });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".join-brain").screenshot({ path: "test-results/screens/narrow-setup-join.png" });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
  await joinBrain.click();
  await page.getByRole("button", { name: "Use this folder" }).click();
  await expect(page.getByRole("heading", { name: "Choose what Attache does" })).toBeVisible();
  await setupScreens(page, "features");
  await page.getByRole("button", { name: "Continue" }).click();
  const gh = page.locator('[data-connection="github"]');
  await gh.getByRole("button", { name: "Set up" }).click();
  await setupScreens(page, "connections");
  await gh.getByRole("textbox", { name: "Token" }).fill("ghp_fixturetokenfixturetoken12345678");
  await gh.getByRole("button", { name: "Connect" }).click();
  await expect(gh.getByText("connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  const model = page.locator('[data-connection="model"]');
  await model.getByRole("button", { name: "Set up" }).click();
  await model.getByRole("combobox", { name: "How to connect" }).selectOption("openai-compatible");
  await model.getByRole("textbox", { name: "Base URL" }).fill(`${stack.fixtureUrl}/model`);
  await model.getByRole("textbox", { name: "Model" }).fill("fixture-model");
  await model.getByRole("button", { name: "Connect" }).click();
  await expect(model.getByText("connected", { exact: true })).toBeVisible();
  await setupScreens(page, "model");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator('[data-feature-status="attention"]')).toBeVisible();
  await setupScreens(page, "finish");
  await page.getByRole("button", { name: "Finish setup" }).click();
  const pr = inboxRow(page, "Add checkout retry");
  await expect(pr).toBeVisible({ timeout: 20_000 });
  await openRow(pr);
  await pr.getByRole("button", { name: "Prepare draft" }).click();
  await page.getByRole("button", { name: "Briefings" }).click();
  await page.getByRole("button", { name: /^Prepare a briefing/ }).click();
  await page.waitForTimeout(1500);
  // Nothing written without review yet: Recently added says so in one line. A fresh load clears the toasts above.
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(stack.url);
    await expect(page.getByRole("region", { name: "Recently added" })).toContainText("Nothing was written without your review");
    await page.getByRole("region", { name: "Recently added" }).screenshot({ path: `test-results/screens/${scheme}-home-recently-added-empty.png` });
  }
  // A pending Proposal, so Approvals shows the review list.
  await page.evaluate(async () => {
    const item = { action: "create", type: "person", title: "Lena Berg", facts: [{ subject: "Role", value: "Postmark account manager" }, { subject: "Team", value: "Vendor management" }], notes: "Met on the vendor call.\nPrefers email.", events: ["Introduced in the vendor call"], tags: ["vendor"] };
    const res = await fetch("/api/v1/memory/proposals", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-attache-client": "1" }, body: JSON.stringify({ item, reason: "Introduced in the vendor call", source: { kind: "agent-session", ref: "claude-code/sess-visual", label: "Claude Code session in attache" }, evidence: "Lena from Postmark joined the call; she manages our account and prefers email." }) });
    if (!res.ok) throw new Error(`propose failed: ${res.status}`);
  });
  // Recent saves on the Brain screen: a correction, a reverted one, and one a later save overwrote.
  await harnessSave(stack, [{ action: "create", type: "person", title: "Priya Shah", facts: [{ subject: "Role", value: "Engineering manager for billing" }, { subject: "Prefers", value: "Written updates on Mondays" }] }], { agent: "claude-code", session: "6f1c2b0e-visual" });
  await harnessSave(stack, [{ action: "update", path: "memory/people/priya-shah.md", facts: [{ subject: "Role", value: "Director of platform engineering, owning billing, ledger and the payments roadmap through 2027", reason: "promotion", review: new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10) }] }], { agent: "codex", session: "thread-visual-2" });
  await harnessSave(stack, [{ action: "update", path: "memory/people/priya-shah.md", facts: [{ subject: "Prefers", value: "Written updates on Fridays", reason: "new rhythm" }] }], { agent: "claude-code", session: "6f1c2b0e-visual" });
  await harnessSave(stack, [{ action: "update", path: "memory/people/priya-shah.md", facts: [{ subject: "Prefers", value: "A short call on Fridays", reason: "changed again" }] }], { agent: "claude-code", session: "6f1c2b0e-visual" });
  // A pending correction, so the review list shows an old value struck through beside the new one.
  await page.evaluate(async () => {
    const item = { action: "update", path: "memory/people/priya-shah.md", facts: [{ subject: "Prefers", value: "Written updates on Mondays again", reason: "The Friday call clashed with the release meeting." }] };
    const res = await fetch("/api/v1/memory/proposals", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-attache-client": "1" }, body: JSON.stringify({ item, reason: "The Friday call clashed with the release meeting.", evidence: "Priya asked to go back to written updates on Mondays." }) });
    if (!res.ok) throw new Error(`propose failed: ${res.status}`);
  });
  // Claude Code connected, so auto-accept is on by default, and one save written without review, so Settings and Recent saves show both.
  await page.evaluate(async () => {
    const res = await fetch("/api/v1/connections/claude-code/configure", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-attache-client": "1" }, body: JSON.stringify({ method: "hooks", fields: {} }) });
    if (!res.ok) throw new Error(`POST /connections/claude-code/configure failed: ${res.status}`);
  });
  await harnessSave(stack, [{ action: "update", path: "memory/people/priya-shah.md", events: ["Agreed to own the ledger migration"] }], { agent: "claude-code", session: "6f1c2b0e-visual" });
  // Home's Recently added: a new fact a later save corrected, the correction with its reason, and a note that was reverted.
  await harnessSave(stack, [{ action: "update", path: "memory/people/priya-shah.md", facts: [{ subject: "Office", value: "Copenhagen", reason: "joined the billing floor" }] }], { agent: "claude-code", session: "6f1c2b0e-visual" });
  await harnessSave(stack, [{ action: "update", path: "memory/people/priya-shah.md", facts: [{ subject: "Office", value: "Aarhus, from the first of next month while the Copenhagen floor is rebuilt", reason: "moving with the billing team" }] }], { agent: "claude-code", session: "6f1c2b0e-visual" });
  await harnessSave(stack, [{ action: "create", type: "note", title: "Ledger rehearsal checklist", facts: [{ subject: "Owner", value: "Priya Shah" }] }], { agent: "claude-code", session: "6f1c2b0e-visual" });
  const { changes } = await api<{ changes: Array<{ id: string; kind: string; title: string }> }>(page, "GET", "/memory/recent-changes?unreviewed=1");
  await api(page, "POST", `/memory/changes/${changes.find((c) => c.kind === "create" && c.title === "Ledger rehearsal checklist")!.id}/revert`);
  // A note Consolidation wrote from a meeting, beside the auto-accepted saves, with the meeting as its source.
  const said = "We agreed Priya runs the ledger cutover rehearsal on Thursdays";
  arriveMeetingCapture(stack, "evidence/captures/2026-11-17-granola-ledger-sync.md", "Granola 2026-11-17: Ledger sync", [`[0:04] Priya: ${said}.`], {
    proposals: [{ item: { action: "create", type: "project", title: "Ledger cutover rehearsal", facts: [{ subject: "When", value: "Thursdays, run by Priya Shah" }] }, reason: "The ledger sync agreed a weekly rehearsal.", evidence: said }],
  });
  await expect.poll(() => existsSync(join(stack.dataDir, "memory/projects/ledger-cutover-rehearsal.md"))).toBe(true);
  await replicationScreens(page);
  // An edit by hand: "Prefers" is past its Review date, so the note shows it unverified.
  const priya = join(stack.dataDir, "memory/people/priya-shah.md");
  writeFileSync(priya, readFileSync(priya, "utf8").replace(/\*\*Prefers\*\* \(\d{4}-\d{2}-\d{2}\)/, "**Prefers** (2026-01-10, review 2026-02-01)"));
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [name, path] of [["home", "/"], ["brain", "/brain?tab=person"], ["approvals", "/approvals"], ["jobs", "/jobs"], ["connections", "/connections"], ["settings", "/settings"]] as const) {
      await page.goto(`${stack.url}${path}`);
      await page.waitForTimeout(600);
      await page.screenshot({ path: `test-results/screens/${scheme}-${name}.png`, fullPage: false });
    }
    // Below the fold of the settings screenshot.
    await page.locator(".card", { has: page.getByRole("heading", { name: "This Machine" }) }).screenshot({ path: `test-results/screens/${scheme}-settings-machine.png` });
    await page.locator(".card", { has: page.getByRole("heading", { name: "Service health" }) }).screenshot({ path: `test-results/screens/${scheme}-settings-health.png` });
    await page.locator("[data-meaning-search]").screenshot({ path: `test-results/screens/${scheme}-settings-meaning.png` });
    await page.getByRole("region", { name: "Auto-accept" }).screenshot({ path: `test-results/screens/${scheme}-settings-auto-accept.png` });
    // A note opened read-only, below the review lists.
    await page.goto(`${stack.url}/brain?tab=person&path=${encodeURIComponent("memory/people/priya-shah.md")}`);
    await page.locator("[data-subject]").first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `test-results/screens/${scheme}-brain-note.png` });
    await page.goto(`${stack.url}/brain`);
    await page.getByRole("region", { name: "Recent saves" }).screenshot({ path: `test-results/screens/${scheme}-recent-saves.png` });
    await page.goto(stack.url);
    await expect(page.getByRole("region", { name: "Recently added" }).getByRole("listitem").first()).toBeVisible();
    await page.getByRole("region", { name: "Recently added" }).screenshot({ path: `test-results/screens/${scheme}-home-recently-added.png` });
    // Search the Brain on Home: results under the field as the owner types, then Browse open.
    await page.evaluate(() => document.querySelector(".page")!.scrollTo(0, 0));
    await page.getByRole("combobox", { name: "Search the Brain" }).fill("Priya");
    await expect(page.getByRole("listbox", { name: "Results" }).getByRole("option").first()).toBeVisible();
    await page.screenshot({ path: `test-results/screens/${scheme}-home-search.png` });
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Browse" }).click();
    await page.locator(".home-search").screenshot({ path: `test-results/screens/${scheme}-home-browse.png` });
    // The frame: this Machine's disclosure under the masthead, then the shortcut sheet.
    await page.goto(`${stack.url}/jobs`);
    await page.getByRole("button", { name: /^This Machine/ }).click();
    await expect(page.getByRole("region", { name: "This Machine" })).toBeVisible();
    await page.screenshot({ path: `test-results/screens/${scheme}-shell-machine.png` });
    await page.keyboard.press("Escape");
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
    await page.screenshot({ path: `test-results/screens/${scheme}-shell-shortcuts.png` });
    await page.keyboard.press("Escape");
  }
  // Search before and after the meaning model is downloaded.
  await page.goto(`${stack.url}/brain`);
  await page.getByRole("searchbox", { name: "Search the Brain" }).fill("Orion");
  await expect(page.locator("[data-keywords-only]")).toBeVisible();
  await page.locator("[data-keywords-only]").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/screens/dark-brain-keywords-only.png", fullPage: false });
  await page.goto(`${stack.url}/settings`);
  const meaning = page.locator("[data-meaning-search]");
  await meaning.getByRole("button", { name: /^Download model/ }).click();
  await expect(meaning.getByText("ready", { exact: true })).toBeVisible({ timeout: 30_000 });
  await meaning.screenshot({ path: "test-results/screens/dark-settings-meaning-ready.png" });
  await page.goto(`${stack.url}/brain`);
  await page.getByRole("searchbox", { name: "Search the Brain" }).fill("When is the cutover plan due for the Orion migration?");
  await page.locator(".list-item", { hasText: "Orion" }).first().click();
  await expect(page.getByRole("dialog", { name: /Evidence/ })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/screens/dark-evidence.png" });
  await page.keyboard.press("Escape");
  await homeConnectionsScreens(page);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [name, path] of [["home", "/"], ["brain", "/brain?tab=person"], ["approvals", "/approvals"], ["jobs", "/jobs"], ["settings", "/settings"], ["connections", "/connections"]] as const) {
    await page.goto(`${stack.url}${path}`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-results/screens/narrow-${name}.png`, fullPage: false });
  }
  await page.goto(`${stack.url}/brain?tab=person&path=${encodeURIComponent("memory/people/priya-shah.md")}`);
  await page.locator("[data-subject]").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "test-results/screens/narrow-brain-note.png" });
  await page.goto(stack.url);
  const recentlyAdded = page.getByRole("region", { name: "Recently added" });
  await expect(recentlyAdded.getByRole("listitem").first()).toBeVisible();
  await recentlyAdded.screenshot({ path: "test-results/screens/narrow-home-recently-added.png" });
  await page.getByRole("combobox", { name: "Search the Brain" }).fill("Priya");
  await expect(page.getByRole("listbox", { name: "Results" }).getByRole("option").first()).toBeVisible();
  await page.evaluate(() => document.querySelector(".page")!.scrollTo(0, 0));
  await page.screenshot({ path: "test-results/screens/narrow-home-search.png" });
  await page.keyboard.press("Escape");
  // The bottom bar's More sheet, with the rest of the screens and this Machine.
  await page.locator(".bottom-bar").getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
  await page.screenshot({ path: "test-results/screens/narrow-shell-more.png" });
  await page.keyboard.press("Escape");
});
