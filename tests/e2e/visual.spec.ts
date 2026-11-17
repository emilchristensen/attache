/** Captures every view in light, dark and narrow layouts for visual review (test-results/screens). */
import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAll, harnessSave, startStack, type Stack } from "./stack.ts";

let stack: Stack;
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  buildAll();
  stack = await startStack();
});
test.afterAll(() => stack?.stop());

const runGit = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Work Mac", GIT_AUTHOR_EMAIL: "w@example.invalid", GIT_COMMITTER_NAME: "Work Mac", GIT_COMMITTER_EMAIL: "w@example.invalid" } });

async function api(page: Page, method: string, path: string, body?: unknown) {
  await page.evaluate(
    async ([m, p, b]) => {
      const res = await fetch(`/api/v1${p}`, { method: m, credentials: "same-origin", headers: { "content-type": "application/json", "x-attache-client": "1" }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) });
      if (!res.ok) throw new Error(`${m} ${p} failed: ${res.status}`);
    },
    [method, path, body] as const,
  );
}

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

test("screens", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(stack.pairUrl());
  await page.getByRole("textbox", { name: /Data folder/ }).fill(stack.dataDir);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("textbox", { name: "Folder to import" }).fill(stack.vaultDir);
  await page.getByRole("button", { name: "Preview import" }).click();
  await page.screenshot({ path: "test-results/screens/setup-folder.png", fullPage: true });
  const joinBrain = page.getByText("Already use Attache on another Machine?");
  await joinBrain.click();
  await page.locator(".join-brain").screenshot({ path: "test-results/screens/setup-join.png" });
  await joinBrain.click();
  await page.getByRole("button", { name: "Use this folder" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  const gh = page.locator('[data-connection="github"]');
  await gh.getByRole("button", { name: "Set up" }).click();
  await page.screenshot({ path: "test-results/screens/setup-connections.png", fullPage: true });
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
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByText(/Review acme\/web#42/)).toBeVisible({ timeout: 20_000 });
  await page.locator("article.item", { hasText: "Review acme/web#42" }).getByRole("button", { name: "Prepare draft" }).click();
  await page.getByRole("button", { name: "Prepare briefing" }).click();
  await page.waitForTimeout(1500);
  // A pending Proposal, so the Memory screens show the review list.
  await page.evaluate(async () => {
    const item = { action: "create", type: "person", title: "Lena Berg", facts: [{ subject: "Role", value: "Postmark account manager" }, { subject: "Team", value: "Vendor management" }], notes: "Met on the vendor call.\nPrefers email.", events: ["Introduced in the vendor call"], tags: ["vendor"] };
    const res = await fetch("/api/v1/memory/proposals", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-attache-client": "1" }, body: JSON.stringify({ item, reason: "Introduced in the vendor call", source: { kind: "agent-session", ref: "claude-code/sess-visual", label: "Claude Code session in attache" }, evidence: "Lena from Postmark joined the call; she manages our account and prefers email." }) });
    if (!res.ok) throw new Error(`propose failed: ${res.status}`);
  });
  // Recent saves on the Memory screen: a correction, a reverted one, and one a later save overwrote.
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
  // Claude Code connected with auto-accept on, and one auto-accepted save, so Settings and Recent saves show both.
  await page.evaluate(async () => {
    const call = async (method: string, path: string, body: unknown) => {
      const res = await fetch(`/api/v1${path}`, { method, credentials: "same-origin", headers: { "content-type": "application/json", "x-attache-client": "1" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status}`);
    };
    await call("POST", "/connections/claude-code/configure", { method: "hooks", fields: {} });
    await call("PUT", "/harnesses/claude-code/auto-accept", { autoAccept: true });
  });
  await harnessSave(stack, [{ action: "update", path: "memory/people/priya-shah.md", events: ["Agreed to own the ledger migration"] }], { agent: "claude-code", session: "6f1c2b0e-visual" });
  await replicationScreens(page);
  // An edit by hand: "Prefers" is past its Review date, so the note shows it unverified.
  const priya = join(stack.dataDir, "memory/people/priya-shah.md");
  writeFileSync(priya, readFileSync(priya, "utf8").replace(/\*\*Prefers\*\* \(\d{4}-\d{2}-\d{2}\)/, "**Prefers** (2026-01-10, review 2026-02-01)"));
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [name, path] of [["home", "/"], ["memory", "/memory?tab=person"], ["drafts", "/drafts"], ["jobs", "/jobs"], ["connections", "/connections"], ["settings", "/settings"]] as const) {
      await page.goto(`${stack.url}${path}`);
      await page.waitForTimeout(600);
      await page.screenshot({ path: `test-results/screens/${scheme}-${name}.png`, fullPage: false });
    }
    // Below the fold of the settings screenshot.
    await page.locator(".card", { has: page.getByRole("heading", { name: "This Machine" }) }).screenshot({ path: `test-results/screens/${scheme}-settings-machine.png` });
    await page.locator(".card", { has: page.getByRole("heading", { name: "Service health" }) }).screenshot({ path: `test-results/screens/${scheme}-settings-health.png` });
    await page.locator("[data-meaning-search]").screenshot({ path: `test-results/screens/${scheme}-settings-meaning.png` });
    await page.getByRole("region", { name: "Auto-accept saves" }).screenshot({ path: `test-results/screens/${scheme}-settings-auto-accept.png` });
    // A note opened read-only, below the review lists.
    await page.goto(`${stack.url}/memory?tab=person&path=${encodeURIComponent("memory/people/priya-shah.md")}`);
    await page.locator("[data-subject]").first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await page.screenshot({ path: `test-results/screens/${scheme}-memory-note.png` });
    await page.goto(`${stack.url}/memory`);
    await page.getByRole("region", { name: "Recent saves" }).screenshot({ path: `test-results/screens/${scheme}-recent-saves.png` });
  }
  // Search before and after the meaning model is downloaded.
  await page.goto(`${stack.url}/memory`);
  await page.getByRole("searchbox", { name: "Search memory" }).fill("Orion");
  await expect(page.locator("[data-keywords-only]")).toBeVisible();
  await page.locator("[data-keywords-only]").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/screens/dark-memory-keywords-only.png", fullPage: false });
  await page.goto(`${stack.url}/settings`);
  const meaning = page.locator("[data-meaning-search]");
  await meaning.getByRole("button", { name: /^Download model/ }).click();
  await expect(meaning.getByText("ready", { exact: true })).toBeVisible({ timeout: 30_000 });
  await meaning.screenshot({ path: "test-results/screens/dark-settings-meaning-ready.png" });
  await page.goto(`${stack.url}/memory`);
  await page.getByRole("searchbox", { name: "Search memory" }).fill("When is the cutover plan due for the Orion migration?");
  await page.locator(".list-item", { hasText: "Orion" }).first().click();
  await expect(page.getByRole("dialog", { name: /Evidence/ })).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/screens/dark-evidence.png" });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [name, path] of [["home", "/"], ["memory", "/memory?tab=person"], ["drafts", "/drafts"], ["settings", "/settings"], ["connections", "/connections"]] as const) {
    await page.goto(`${stack.url}${path}`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-results/screens/narrow-${name}.png`, fullPage: false });
  }
  await page.goto(`${stack.url}/memory?tab=person&path=${encodeURIComponent("memory/people/priya-shah.md")}`);
  await page.locator("[data-subject]").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "test-results/screens/narrow-memory-note.png" });
});
