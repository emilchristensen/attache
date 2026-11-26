/**
 * Settings' Updates section (#140 of spec #130): every status the Updater reports, Automatic updates and the Update
 * channel kept across a reload, and Check now, Install now and Restart now, driven through the Dashboard. The service
 * runs as a release install (`update-service.ts`) against a TEST-ONLY local release server with releases signed by a
 * test key; its installer runner only records what it is asked, and the journey plays the installer's outcome and the
 * restart on the new version. A development install, where Updates are unavailable, is in `settings.spec.ts`.
 */
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import type { UpdatesView } from "@attache/contracts";
import { signedRelease, testReleaseKeys } from "../../apps/service/test/fixtures/signed-release.ts";
import { startReleaseServer, type ReleaseServer } from "../../apps/service/test/fixtures/release-server.ts";
import { installerFinished } from "../../apps/service/test/fixtures/installer-outcome.ts";
import { axeFindings } from "./a11y.ts";
import { api, dashboardAnswer, JourneyBrowser, settled } from "./browser.ts";
import { buildAll, installRequests, startStack, type Stack } from "./stack.ts";

let stack: Stack;
let journeys: JourneyBrowser;
let releases: ReleaseServer;
const key = testReleaseKeys();

test.describe.configure({ mode: "serial" });

/** Publish `version` on the release server, signed with the key the service trusts. */
function publish(version: string) {
  releases.publish(version, signedRelease({ version, key, notes: `### What's new\n\n**Briefings name their meeting.**\nA briefing says which meeting it prepares for.\n\n### Fixed\n\n- Faster search in large Brains.\n` }));
}

test.beforeAll(async ({ browser }) => {
  buildAll();
  releases = await startReleaseServer();
  // Nothing newer than this Machine at first, so the check when the service starts finds it up to date.
  stack = await startStack({ updates: { feedUrl: releases.feedUrl, publicKey: key.publicKey, version: "0.6.0" } });
  journeys = await JourneyBrowser.start(browser, stack.url);
  const page = await journeys.newPage();
  await page.goto(stack.pairUrl());
  await expect(page.getByRole("heading", { name: "Where should Attache keep your knowledge?" })).toBeVisible();
  await api(page, "POST", "/setup/data-folder", { path: stack.dataDir });
  await api(page, "POST", "/setup/identity", { name: "Test User", email: "alex@example.com", confirm: true });
  await api(page, "POST", "/setup/complete");
  await page.close();
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
  await releases?.close();
});

const section = (page: Page) => page.locator('[data-settings-section="updates"]');
const status = (page: Page) => section(page).locator("[data-updates-status]");
const button = (page: Page, name: string) => section(page).getByRole("button", { name, exact: true });
const radio = (page: Page, name: string) => section(page).getByRole("radio", { name, exact: true });

/** The Updates section, once it shows the status the service reports. */
async function open(page: Page, state: UpdatesView["status"]) {
  await page.goto(`${stack.url}/settings/updates`);
  await expect(section(page).locator(`[data-updates-status="${state}"]`)).toBeVisible();
}

/** Wait until the Dashboard has heard the service report `state`. */
const reported = (page: Page, state: UpdatesView["status"]) => dashboardAnswer<UpdatesView>(page, "/updates", (v) => v.status === state);

const SHOTS = "test-results/screens";
const VIEWS = [
  ["light", { width: 1280, height: 1300 }],
  ["dark", { width: 1280, height: 1300 }],
  ["light", { width: 390, height: 1700 }],
  ["dark", { width: 390, height: 1700 }],
] as const;

/** Capture the section as it is now in both themes at desktop and phone widths; each has no axe finding and nothing wider than the window. */
async function capture(page: Page, name: string) {
  // A notification the last step raised would cover the section.
  for (const dismiss of await page.getByRole("button", { name: "Dismiss notification" }).all()) await dismiss.click();
  for (const [scheme, viewport] of VIEWS) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize(viewport);
    await settled(page);
    const where = `${name}, ${scheme}, ${viewport.width} px`;
    expect(await axeFindings(page), where).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${where} fits the window`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SHOTS}/updates-${name}-${scheme}-${viewport.width}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1360, height: 900 });
}

test("up to date, then a failed check says why, and Check now looks again", async () => {
  const page = await journeys.open("/settings/updates");
  await open(page, "up_to_date");
  await expect(status(page).getByRole("heading", { name: "Attache is up to date" })).toBeVisible();
  await expect(section(page).locator("[data-installed-version]")).toHaveText("Attache 0.6.0");
  await expect(section(page).locator("[data-last-check]")).toContainText("up to date");
  await expect(button(page, "Install now")).toHaveCount(0);
  await expect(radio(page, "Automatic")).toBeChecked();
  await expect(radio(page, "Stable")).toBeChecked();
  await capture(page, "up-to-date");

  releases.failWith(503);
  const failed = reported(page, "check_failed");
  await button(page, "Check now").click();
  const { reason } = await failed;
  expect(reason).toBeTruthy();
  await expect(status(page).getByRole("heading", { name: "The last check failed" })).toBeVisible();
  await expect(status(page).getByText(reason!, { exact: true })).toBeVisible();
  await expect(section(page).locator("[data-last-check]")).toContainText("failed");
  await capture(page, "check-failed");

  // While the check runs, its status offers no Check now; the button pressed stays, disabled and saying so, until the answer.
  releases.failWith(null);
  const letThrough = releases.hold();
  const checking = reported(page, "checking");
  await button(page, "Check now").click();
  await checking;
  await expect(status(page).getByRole("heading", { name: "Looking for an Update…" })).toBeVisible();
  await expect(button(page, "Checking…")).toBeVisible();
  await expect(button(page, "Checking…")).toBeDisabled();
  const again = reported(page, "up_to_date");
  letThrough();
  await again;
  await expect(status(page).getByRole("heading", { name: "Attache is up to date" })).toBeVisible();
  await expect(button(page, "Check now")).toBeEnabled();
});

test("Automatic updates and the Update channel take effect and survive a reload; Off makes no request", async () => {
  const page = await journeys.open("/settings/updates");
  await open(page, "up_to_date");
  await radio(page, "Beta").check();
  await expect(page.getByText("Update channel: Beta")).toBeVisible();
  await radio(page, "Off").check();
  await expect(page.getByText("Automatic updates: Off")).toBeVisible();
  expect(await api<UpdatesView>(page, "GET", "/updates")).toMatchObject({ mode: "off", channel: "beta", status: "off" });

  await page.reload();
  await open(page, "off");
  await expect(radio(page, "Off")).toBeChecked();
  await expect(radio(page, "Beta")).toBeChecked();
  await expect(status(page).getByRole("heading", { name: "Automatic updates is Off" })).toBeVisible();
  // Off makes no request at all, so there is nothing to check or install.
  await expect(button(page, "Check now")).toHaveCount(0);
  await expect(button(page, "Install now")).toHaveCount(0);
  await capture(page, "off");

  const asked = releases.requests.length;
  await radio(page, "Stable").check();
  await expect(page.getByText("Update channel: Stable")).toBeVisible();
  expect(releases.requests.length, "Off asked the release server nothing").toBe(asked);

  // Ask first, kept for the next journeys; turning Updates back on looks at once.
  const checked = reported(page, "up_to_date");
  await radio(page, "Ask first").check();
  await checked;
  await page.reload();
  await open(page, "up_to_date");
  await expect(radio(page, "Ask first")).toBeChecked();
  await expect(radio(page, "Stable")).toBeChecked();
});

test("Ask first: Check now downloads an Update and waits; Install now hands it to the installer, and the restart shows what changed", async () => {
  publish("0.7.0");
  const page = await journeys.open("/settings/updates");
  await open(page, "up_to_date");
  const ready = reported(page, "ready");
  await button(page, "Check now").click();
  await ready;
  await expect(status(page).getByRole("heading", { name: "Attache 0.7.0 is ready to install" })).toBeVisible();
  await expect(section(page).locator("[data-last-check]")).toContainText("found Attache 0.7.0");
  await section(page).getByText("What's in Attache 0.7.0").click();
  await expect(section(page).getByText("A briefing says which meeting it prepares for.")).toBeVisible();
  await capture(page, "ready");

  const installing = reported(page, "installing");
  await button(page, "Install now").click();
  await installing;
  await expect(status(page).getByRole("heading", { name: "Installing Attache 0.7.0" })).toBeVisible();
  // Install now is gone with the status that offered it, so focus is on what happens now, not lost.
  await expect(status(page).getByRole("heading", { name: "Installing Attache 0.7.0" })).toBeFocused();
  // While the installer runs, the settings wait for the version it starts, and say so.
  await expect(radio(page, "Automatic")).toBeDisabled();
  await expect(radio(page, "Beta")).toBeDisabled();
  await expect(section(page).getByText("Automatic updates and the Update channel can change once Attache 0.7.0 has finished installing.")).toBeVisible();
  expect(installRequests(stack)).toEqual(["0.7.0"]);
  await capture(page, "installing");

  // The installer switches versions and the service starts again on 0.7.0.
  installerFinished(stack.stateDir, { outcome: "updated", from: "0.6.0", to: "0.7.0" });
  await stack.stopService();
  await stack.startService({ version: "0.7.0" });
  await open(page, "up_to_date");
  await expect(section(page).locator("[data-installed-version]")).toHaveText("Attache 0.7.0");
  const last = section(page).locator('[data-last-update="updated"]');
  await expect(last.getByRole("heading", { name: "Attache updated from 0.6.0 to 0.7.0" })).toBeVisible();
  await last.getByText("What changed").click();
  await expect(last.getByText("Faster search in large Brains.")).toBeVisible();
  await capture(page, "updated");
});

test("Automatic: an Update waits for a running Job; Restart now installs it at once, and a rollback says why", async () => {
  const page = await journeys.open("/settings/updates");
  await open(page, "up_to_date");
  await radio(page, "Automatic").check();
  await expect(page.getByText("Automatic updates: Automatic")).toBeVisible();
  const job = (await api<{ job: { id: string } }>(page, "POST", "/jobs", { kind: "demo-long", title: "Diagnostics: a long run", input: { steps: 300, stepMs: 1000, effectAtStep: -1 } })).job.id;
  try {
    await expect.poll(async () => (await api<Array<{ status: string }>>(page, "GET", "/jobs?status=running")).length).toBe(1);
    publish("0.8.0");
    const waiting = reported(page, "waiting_for_jobs");
    await button(page, "Check now").click();
    await waiting;
    await expect(status(page).getByRole("heading", { name: "Attache 0.8.0 is waiting for 1 Job to finish" })).toBeVisible();
    await expect(button(page, "Check now")).toHaveCount(0);
    await capture(page, "waiting");

    const installing = reported(page, "installing");
    await button(page, "Restart now").click();
    await installing;
    expect(installRequests(stack)).toEqual(["0.7.0", "0.8.0"]);
  } finally {
    await api(page, "POST", `/jobs/${job}/cancel`);
  }

  // 0.8.0 did not come up, so the installer switched back: this service, still on 0.7.0, reads the outcome.
  const rolledBack = dashboardAnswer<UpdatesView>(page, "/updates", (v) => v.lastUpdate?.outcome === "rolled_back");
  installerFinished(stack.stateDir, { outcome: "rolled_back", from: "0.7.0", to: "0.8.0", reason: "Attache 0.8.0 did not answer within 30 seconds.", database: "restored", backup: join(stack.stateDir, "backups", "pre-update-0.7.0-to-0.8.0-20261126090000.tar.gz") });
  await rolledBack;
  const last = section(page).locator('[data-last-update="rolled_back"]');
  await expect(last.getByRole("heading", { name: "The Update to 0.8.0 failed, so Attache went back to 0.7.0" })).toBeVisible();
  await expect(last.getByText("Attache 0.8.0 did not answer within 30 seconds. The database was restored from the backup taken just before the Update.")).toBeVisible();
  await expect(section(page).locator("[data-installed-version]")).toHaveText("Attache 0.7.0");
  await capture(page, "rolled-back");
  expect(journeys.consoleErrors).toEqual([]);
});
