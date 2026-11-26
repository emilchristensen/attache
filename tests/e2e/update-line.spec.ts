/**
 * The line under the masthead about Updates (#141 of spec #130): each line in the state that shows it, with exact
 * counts, after the Connection banner when both show; What changed showing the release notes with no request outside
 * the service; the updated line gone after one day; and the Decision count and the Attention dot untouched by every
 * Update state. The service runs as a release install (`update-service.ts`) against a TEST-ONLY local release server
 * with releases signed by a test key; its installer runner only records what it is asked, and the journey plays the
 * installer's outcome and the restart. Each line is captured in both themes at desktop and phone widths, with axe.
 * Last, a Machine whose Replication paused on a newer Brain format (#143) asks to be updated, and the line goes once
 * the Update that reads the format is installed and Replication resumes.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import type { ReplicationView, UpdatesView } from "@attache/contracts";
import { signedRelease, testReleaseKeys } from "../../apps/service/test/fixtures/signed-release.ts";
import { startReleaseServer, type ReleaseServer } from "../../apps/service/test/fixtures/release-server.ts";
import { installerFinished } from "../../apps/service/test/fixtures/installer-outcome.ts";
import { axeFindings } from "./a11y.ts";
import { api, dashboardAnswer, JourneyBrowser, settled } from "./browser.ts";
import { buildAll, installRequests, startStack, type Stack } from "./stack.ts";

let stack: Stack;
let journeys: JourneyBrowser;
let releases: ReleaseServer;
/** The Decision count before any Update: no Update state may change it. */
let decisions: unknown;
const key = testReleaseKeys();
const DAY = 24 * 60 * 60_000;

test.describe.configure({ mode: "serial" });

function publish(version: string) {
  releases.publish(version, signedRelease({ version, key, notes: `### What's new\n\n**Briefings name their meeting.**\nA briefing says which meeting it prepares for.\n\n### Fixed\n\n- Faster search in large Brains.\n` }));
}

test.beforeAll(async ({ browser }) => {
  buildAll();
  releases = await startReleaseServer();
  stack = await startStack({ updates: { feedUrl: releases.feedUrl, publicKey: key.publicKey, version: "0.6.0" } });
  journeys = await JourneyBrowser.start(browser, stack.url);
  const page = await journeys.newPage();
  await page.goto(stack.pairUrl());
  await expect(page.getByRole("heading", { name: "Where should Attache keep your knowledge?" })).toBeVisible();
  await api(page, "POST", "/setup/data-folder", { path: stack.dataDir });
  await api(page, "POST", "/setup/identity", { name: "Test User", email: "alex@example.com", confirm: true });
  await api(page, "POST", "/setup/complete");
  decisions = await api(page, "GET", "/decision-count");
  await page.close();
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
  await releases?.close();
});

const line = (page: Page) => page.locator("[data-update-line]");
const connectionBanner = (page: Page) => page.locator("[data-connection-banner]");

/** Wait until the Dashboard has heard the service report what `accept` looks for. */
const reported = (page: Page, accept: (v: UpdatesView) => boolean) => dashboardAnswer<UpdatesView>(page, "/updates", accept);

/** The line shows `text` with its action named `action` (none when null), and nothing else counts it as a decision. */
async function expectLine(page: Page, state: string, text: string, action: string | null) {
  const shown = line(page);
  await expect(shown).toBeVisible();
  await expect(shown).toHaveAttribute("data-state", state);
  await expect(shown.locator(".update-line-text")).toHaveText(text);
  if (action) await expect(shown.getByRole(action === "Details" ? "link" : "button", { name: action, exact: true })).toBeVisible();
  else await expect(shown.getByRole("button")).toHaveCount(0);
  await expectNoDecision(page);
}

/** The Decision count, the logo's dot and the tab title are as they were before any Update. */
async function expectNoDecision(page: Page) {
  expect(await api(page, "GET", "/decision-count"), "the Decision count").toEqual(decisions);
  await expect(page.locator(".masthead .brand .logo-dot")).toHaveCount(0);
  await expect(page.locator(".masthead .brand-total")).toHaveCount(0);
  await expect(page).toHaveTitle("Attache");
}

const SHOTS = "test-results/screens";
const VIEWS = [
  ["light", { width: 1280, height: 800 }],
  ["dark", { width: 1280, height: 800 }],
  ["light", { width: 390, height: 844 }],
  ["dark", { width: 390, height: 844 }],
] as const;

/** Capture the page as it is now in both themes at desktop and phone widths; each has no axe finding and nothing wider than the window. */
async function capture(page: Page, name: string, target?: () => Promise<void>) {
  for (const dismiss of await page.getByRole("button", { name: "Dismiss notification" }).all()) await dismiss.click();
  for (const [scheme, viewport] of VIEWS) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize(viewport);
    await target?.();
    await settled(page);
    const where = `${name}, ${scheme}, ${viewport.width} px`;
    expect(await axeFindings(page), where).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${where} fits the window`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOTS}/update-line-${name}-${scheme}-${viewport.width}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1360, height: 900 });
}

test("no line while nothing happened; Ask first: 'Attache 0.7.0 is ready to install · Install', after the Connection banner, and Install hands it to the installer", async () => {
  const page = await journeys.open("/");
  await expect(page.getByRole("heading", { level: 2, name: "Inbox" })).toBeVisible();
  await expect(line(page)).toHaveCount(0);
  await api(page, "PUT", "/updates/settings", { mode: "ask_first" });

  publish("0.7.0");
  const ready = reported(page, (v) => v.status === "ready");
  await api(page, "POST", "/updates/check", { reportOnly: false });
  await ready;
  await expectLine(page, "ready", "Attache 0.7.0 is ready to install", "Install");
  // No Harness is set up here, so a Connection issue shows too: the Connection banner comes first, the line right under it.
  await expect(connectionBanner(page)).toBeVisible();
  const order = await page.evaluate(() => {
    const banner = document.querySelector("[data-connection-banner]")!;
    const update = document.querySelector("[data-update-line]")!;
    return { bannerFirst: Boolean(banner.compareDocumentPosition(update) & Node.DOCUMENT_POSITION_FOLLOWING), gap: update.getBoundingClientRect().top - banner.getBoundingClientRect().bottom };
  });
  expect(order.bannerFirst, "the Connection banner comes first").toBe(true);
  expect(Math.abs(order.gap), "the line sits right under the Connection banner").toBeLessThan(1);
  await capture(page, "ready");

  const installing = reported(page, (v) => v.status === "installing");
  await line(page).getByRole("button", { name: "Install", exact: true }).click();
  await installing;
  expect(installRequests(stack)).toEqual(["0.7.0"]);
  await expectLine(page, "installing", "Installing Attache 0.7.0", null);
  // Install is gone with the line that offered it: focus is on what the line says now, not lost.
  await expect(line(page).locator(".update-line-text")).toBeFocused();
  await capture(page, "installing");
});

test("'Attache updated from 0.6.0 to 0.7.0 · What changed' shows the release notes with no request outside the service, and is gone a day later", async () => {
  installerFinished(stack.stateDir, { outcome: "updated", from: "0.6.0", to: "0.7.0" });
  await stack.stopService();
  await stack.startService({ version: "0.7.0" });
  const page = await journeys.open("/");
  const elsewhere: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).origin !== new URL(stack.url).origin) elsewhere.push(r.url());
  });
  await page.reload();
  await expectLine(page, "updated", "Attache updated from 0.6.0 to 0.7.0", "What changed");
  await capture(page, "updated");

  const whatChanged = line(page).getByRole("button", { name: "What changed", exact: true });
  await whatChanged.click();
  const notes = page.getByRole("dialog", { name: "What changed in Attache 0.7.0" });
  await expect(notes.getByText("A briefing says which meeting it prepares for.")).toBeVisible();
  await expect(notes.getByText("Faster search in large Brains.")).toBeVisible();
  await capture(page, "what-changed", async () => {
    if (!(await notes.isVisible())) await whatChanged.click();
  });
  await expect(notes).toBeVisible();
  await notes.getByRole("button", { name: "Close" }).click();
  await expect(notes).toBeHidden();
  await expect(whatChanged).toBeFocused();
  expect(elsewhere, "the Dashboard asked nothing outside the service").toEqual([]);

  // The same Update, finished a day ago: Settings still tells it, the line no longer does.
  installerFinished(stack.stateDir, { outcome: "updated", from: "0.6.0", to: "0.7.0", at: new Date(Date.now() - DAY - 60_000).toISOString() });
  await stack.stopService();
  await stack.startService({ version: "0.7.0" });
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "Inbox" })).toBeVisible();
  await settled(page);
  await expect(line(page)).toHaveCount(0);
  expect((await api<UpdatesView>(page, "GET", "/updates")).lastUpdate).toMatchObject({ outcome: "updated", to: "0.7.0" });
});

test("Automatic: 'Attache 0.8.0 is waiting for 1 Job to finish', then 2 Jobs, · Restart now installs it at once", async () => {
  const page = await journeys.open("/jobs");
  await api(page, "PUT", "/updates/settings", { mode: "automatic" });
  const long = { kind: "demo-long", input: { steps: 300, stepMs: 1000, effectAtStep: -1 } };
  const jobs = [(await api<{ job: { id: string } }>(page, "POST", "/jobs", { ...long, title: "Diagnostics: a long run" })).job.id];
  try {
    await expect.poll(async () => (await api<unknown[]>(page, "GET", "/jobs?status=running")).length).toBe(1);
    publish("0.8.0");
    const waiting = reported(page, (v) => v.status === "waiting_for_jobs" && v.jobs === 1);
    await api(page, "POST", "/updates/check", { reportOnly: false });
    await waiting;
    await expectLine(page, "waiting_for_jobs", "Attache 0.8.0 is waiting for 1 Job to finish", "Restart now");

    const two = reported(page, (v) => v.status === "waiting_for_jobs" && v.jobs === 2);
    jobs.push((await api<{ job: { id: string } }>(page, "POST", "/jobs", { ...long, title: "Diagnostics: another long run" })).job.id);
    await two;
    await expectLine(page, "waiting_for_jobs", "Attache 0.8.0 is waiting for 2 Jobs to finish", "Restart now");
    await capture(page, "waiting");

    const installing = reported(page, (v) => v.status === "installing");
    await line(page).getByRole("button", { name: "Restart now", exact: true }).click();
    await installing;
    expect(installRequests(stack)).toEqual(["0.7.0", "0.8.0"]);
    await expectLine(page, "installing", "Installing Attache 0.8.0", null);
  } finally {
    for (const id of jobs) await api(page, "POST", `/jobs/${id}/cancel`);
  }
});

test("a rollback: 'The Update to 0.8.0 failed, so Attache went back to 0.7.0 · Details' leads to Settings, which shows it without the line", async () => {
  const page = await journeys.open("/");
  const rolledBack = reported(page, (v) => v.lastUpdate?.outcome === "rolled_back");
  installerFinished(stack.stateDir, { outcome: "rolled_back", from: "0.7.0", to: "0.8.0", reason: "Attache 0.8.0 did not answer within 30 seconds.", database: "restored", backup: join(stack.stateDir, "backups", "pre-update-0.7.0-to-0.8.0-20261126090000.tar.gz") });
  await rolledBack;
  await expectLine(page, "rolled_back", "The Update to 0.8.0 failed, so Attache went back to 0.7.0", "Details");
  await capture(page, "rolled-back");

  await line(page).getByRole("link", { name: "Details", exact: true }).click();
  await expect(page).toHaveURL(`${stack.url}/settings/updates`);
  await expect(page.locator('[data-last-update="rolled_back"]').getByRole("heading", { name: "The Update to 0.8.0 failed, so Attache went back to 0.7.0" })).toBeVisible();
  await expect(line(page)).toHaveCount(0);
  await page.goto(`${stack.url}/settings/service`);
  await expect(line(page)).toBeVisible();
  expect(journeys.consoleErrors).toEqual([]);
});

/** Git in `cwd` as the other Machine, the Work Mac, writes its commits. */
const workMacGit = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "Work Mac", GIT_AUTHOR_EMAIL: "w@example.invalid", GIT_COMMITTER_NAME: "Work Mac", GIT_COMMITTER_EMAIL: "w@example.invalid" } });

test("Replication paused on a newer Brain format: 'Update this Machine to keep replicating', with Updates Off then Ask first, and gone once the Update is installed", async () => {
  const page = await journeys.open("/");
  await api(page, "PUT", "/updates/settings", { mode: "off" });
  // Replication on, then the Work Mac, on a later release, moves the Brain to Brain format 2, which 0.7.0 cannot read.
  const base = mkdtempSync(join(tmpdir(), "attache-e2e-remote-"));
  const remote = join(base, "brain.git");
  workMacGit(base, "init", "--bare", "--quiet", "-b", "main", remote);
  await api(page, "POST", "/replication/setup", { remote });
  const clone = join(base, "work-mac");
  workMacGit(base, "clone", "--quiet", remote, clone);
  mkdirSync(join(clone, "machines"), { recursive: true });
  writeFileSync(join(clone, "machines", "brain-format.json"), `${JSON.stringify({ format: 2, updatedAt: new Date().toISOString(), by: "6b1f0c7e-2d4a-4c55-9a8e-1f2e3d4c5b6a" }, null, 2)}\n`);
  workMacGit(clone, "add", "machines");
  workMacGit(clone, "commit", "--quiet", "-m", "Work Mac: Brain format 2");
  workMacGit(clone, "push", "--quiet", "origin", "main");

  // Off: the line only says so; Details leads to Updates, which says Off. No request goes to the release server.
  const asked = releases.requests.length;
  const paused = dashboardAnswer<ReplicationView>(page, "/replication", (v) => v.status === "paused");
  await api(page, "POST", "/replication/check");
  await paused;
  await expectLine(page, "paused", "Update this Machine to keep replicating", "Details");
  await expect(connectionBanner(page)).toBeVisible();
  const gap = await page.evaluate(() => document.querySelector("[data-update-line]")!.getBoundingClientRect().top - document.querySelector("[data-connection-banner]")!.getBoundingClientRect().bottom);
  expect(Math.abs(gap), "the line sits right under the Connection banner").toBeLessThan(1);
  await capture(page, "paused");
  await line(page).getByRole("link", { name: "Details", exact: true }).click();
  await expect(page).toHaveURL(`${stack.url}/settings/updates`);
  await expect(page.getByRole("heading", { name: "Automatic updates is Off" })).toBeVisible();
  // The section offers what Updates can do itself; the line above it only says why this Machine needs one.
  await expectLine(page, "paused", "Update this Machine to keep replicating", null);
  await capture(page, "paused-updates-section");
  expect(releases.requests.length, "Off makes no request").toBe(asked);
  expect(installRequests(stack)).toEqual(["0.7.0", "0.8.0"]);

  // Ask first: Updates on again checks at once; the line offers the verified Update.
  publish("0.9.0");
  const ready = reported(page, (v) => v.status === "ready" && v.update?.version === "0.9.0");
  await api(page, "PUT", "/updates/settings", { mode: "ask_first" });
  await ready;
  await page.goto(`${stack.url}/`);
  await expectLine(page, "paused", "Update this Machine to keep replicating", "Install");
  await capture(page, "paused-ready");
  const installing = reported(page, (v) => v.status === "installing");
  await line(page).getByRole("button", { name: "Install", exact: true }).click();
  await installing;
  expect(installRequests(stack)).toEqual(["0.7.0", "0.8.0", "0.9.0"]);
  await expectLine(page, "installing", "Installing Attache 0.9.0", null);

  // The installer switches to 0.9.0, which reads Brain format 2: Replication resumes and the line tells of the Update instead.
  installerFinished(stack.stateDir, { outcome: "updated", from: "0.7.0", to: "0.9.0" });
  await stack.stopService();
  await stack.startService({ version: "0.9.0", readsBrainFormat: 2 });
  // Listening before the reload: the page may hear Replication up to date in its first load or after an event, and either must count.
  const resumed = dashboardAnswer<ReplicationView>(page, "/replication", (v) => v.status === "up_to_date");
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "Inbox" })).toBeVisible();
  await resumed;
  await expectLine(page, "updated", "Attache updated from 0.7.0 to 0.9.0", "What changed");
  expect(journeys.consoleErrors).toEqual([]);
  await api(page, "POST", "/replication/off");
});
