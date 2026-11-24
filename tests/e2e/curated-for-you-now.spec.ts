/**
 * For you now as the curated list (spec #82): meeting prep with its reason and Suggested now on its Inbox row, Open
 * prep taking it off, Done with Undo and the hold while focus is inside, a failed Inbox with Retry, and the Daily
 * Briefing's picks when it could not be read. It sets itself up through the API, so it runs on its own.
 */
import { test, expect, type Page } from "@playwright/test";
import { api, JourneyBrowser } from "./browser.ts";
import { buildAll, startStack, type Stack } from "./stack.ts";
import { setCalendar as setFixtureCalendar, type Meeting } from "./meetings.ts";
import { rowAction } from "./inbox.ts";

let stack: Stack;
let journeys: JourneyBrowser;

test.describe.configure({ mode: "serial" });
const forYou = (page: Page) => page.getByRole("region", { name: "For you now" });
const inbox = (page: Page) => page.locator("#inbox");
const itemRow = (page: Page, title: string) => inbox(page).locator("[data-inbox-row]").filter({ has: page.getByRole("button", { name: title, exact: true }) });
const setCalendar = (page: Page, meetings: Meeting[]) => setFixtureCalendar(page, stack, meetings);

test.beforeAll(async ({ browser }) => {
  buildAll();
  stack = await startStack();
  journeys = await JourneyBrowser.start(browser, stack.url, { timezoneId: "Europe/Copenhagen" });
  const page = await journeys.newPage();
  await page.goto(stack.pairUrl());
  await expect(page.getByRole("heading", { name: "Where should Attache keep your knowledge?" })).toBeVisible();
  await api(page, "POST", "/setup/data-folder", { path: stack.dataDir });
  await api(page, "POST", "/setup/identity", { name: "Test User", email: "alex@example.com", confirm: true });
  await api(page, "POST", "/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678" } });
  await api(page, "POST", "/connections/gcal/configure", { method: "claude-ai", fields: {} });
  await api(page, "POST", "/connections/claude-code/configure", { method: "hooks", fields: {} });
  await api(page, "POST", "/setup/complete");
  await api(page, "POST", "/import", { path: stack.vaultDir });
  await api(page, "POST", "/connections/github/refresh");
  await expect.poll(async () => (await api<{ items: unknown[] }>(page, "GET", "/attention?state=open")).items.length, { timeout: 30_000 }).toBeGreaterThan(2);
});

test.afterAll(async () => { await journeys?.close(); await stack?.stop(); });

test("meeting prep appears at 15 minutes, stays in the Inbox, and Open prep removes its suggestion everywhere", async () => {
  const page = await journeys.open("/");
  await setCalendar(page, [{ id: "handover", summary: "Pilot handover", start: 10, end: 40, meetLink: "https://meet.google.com/pilot" }]);
  // Loaded afresh, so the new item is an Inbox row rather than waiting behind Show new items.
  await page.reload();
  const suggested = forYou(page).locator("[data-inbox-row]").filter({ hasText: "Pilot handover" });
  await expect(suggested).toContainText("Starts in 10 min, prep not read");
  // The entry is the Inbox row in its narrow form: Start working, Snooze and Done behind its Actions button.
  for (const name of ["Start working", "Snooze", "Done"] as const) await expect(await rowAction(suggested, name)).toBeVisible();
  // Suggested now is on the Inbox row only, not on the entry that is the suggestion.
  await expect(itemRow(page, "Pilot handover")).toContainText("Suggested now");
  await expect(suggested).not.toContainText("Suggested now");
  // Open prep: the meeting's prep opens in place, and the entry holds still while the pointer is on it.
  await (await rowAction(suggested, "Start working")).click();
  await expect(suggested.locator("[data-meeting-detail]")).toBeVisible();
  // Held under the pointer and focus, the entry keeps its place but shows the item as it is now: In progress, Continue.
  // The tag is drawn, not only present in the text.
  await expect(suggested.locator(".inbox-source .tag", { hasText: "In progress" })).toBeVisible();
  // Its reason has ended, so the words "prep not read" are gone while it holds its place.
  await expect(suggested.locator(".inbox-source")).not.toContainText("prep not read");
  await expect(suggested.getByRole("button", { name: "Continue: Pilot handover" })).toHaveCount(1);
  // A change made elsewhere (another Dashboard, here the API) shows at once too, while the entry still holds still.
  const id = await suggested.getAttribute("data-item-id");
  await api(page, "POST", `/attention/${id}/decision`, { decision: "reopen" });
  await expect(suggested.locator(".inbox-source")).not.toContainText("In progress");
  await api(page, "POST", `/attention/${id}/decision`, { decision: "start" });
  await expect(suggested.locator(".inbox-source .tag", { hasText: "In progress" })).toBeVisible();
  // Once the pointer and focus leave the list, the entry whose reason has ended leaves.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(2, 2);
  await expect(suggested).toHaveCount(0);
  await expect(itemRow(page, "Pilot handover")).toContainText("In progress");
});

test("Done from an entry leaves one line with Undo in its place; the list holds while focus is inside it", async () => {
  const page = await journeys.open("/");
  await setCalendar(page, [{ id: "crit", summary: "Design crit", start: 10, end: 40 }]);
  const first = forYou(page).locator("[data-inbox-row]", { hasText: "Design crit" });
  await expect(first).toBeVisible();
  const before = await first.getAttribute("data-item-id");
  await first.getByRole("button").first().focus();
  await page.waitForTimeout(250);
  await expect(first).toHaveAttribute("data-item-id", before!);
  await (await rowAction(first, "Done")).click();
  const line = forYou(page).locator(`[data-item-id="${before}"][data-decided="done"]`);
  await expect(line).toHaveCount(1);
  await expect(line.getByRole("button", { name: "Undo" })).toBeVisible();
  // The line stays once the keyboard and pointer leave, so a mistake costs one click.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(2, 2);
  // The Inbox is read again without the item before the next hold begins, so that hold starts without its entry.
  await expect(page.getByRole("link", { name: /^Attache, 4 need you/ })).toBeVisible();
  await expect(line).toHaveCount(1);
  // Undo while the list holds still (focus inside it, the pointer on Undo) still brings the entry back in its place.
  await forYou(page).getByRole("heading", { name: "For you now" }).focus();
  await line.getByRole("button", { name: "Undo" }).click();
  await expect(forYou(page).locator("[data-inbox-row]:not([data-decided])").first()).toHaveAttribute("data-item-id", before!);
  await expect(forYou(page).locator(`[data-item-id="${before}"]:not([data-decided])`)).toHaveCount(1);
  // Done for good: after a reload only the live list shows, without the item.
  await (await rowAction(forYou(page).locator(`[data-item-id="${before}"]`), "Done")).click();
  await expect(line).toHaveCount(1);
  await page.reload();
  await expect(forYou(page).locator(`[data-item-id="${before}"]`)).toHaveCount(0);
});

test("Inbox failure is an error with Retry, never an empty curated list", async () => {
  const page = await journeys.newPage();
  await page.route("**/api/v1/attention?state=open*", (route) => route.abort());
  await page.goto(stack.url);
  await expect(forYou(page)).toContainText("Could not read the Inbox.");
  await expect(forYou(page)).not.toContainText("Nothing right now");
  await page.unroute("**/api/v1/attention?state=open*");
  await forYou(page).getByRole("button", { name: "Retry" }).click();
  await expect(forYou(page)).not.toContainText("Could not read the Inbox.");
});

test("a Daily Briefing that could not be read is said under the entries, never hidden by them", async () => {
  const page = await journeys.open("/");
  await setCalendar(page, [{ id: "picks", summary: "Roadmap sync", start: 10, end: 40 }]);
  await page.route("**/api/v1/briefings", (route) => route.abort());
  await page.reload();
  await expect(forYou(page).locator("[data-inbox-row]").filter({ hasText: "Roadmap sync" })).toBeVisible();
  const said = forYou(page).locator("[data-picks-failed]");
  await expect(said).toHaveText("Could not read the Daily Briefing, so its picks are missing. Retry");
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await said.getByRole("button", { name: "Retry" }).click();
  await expect(said).toHaveCount(0);
});

test("a briefing read that fails after a good one keeps the picks and the card, and says so quietly with Retry", async () => {
  const page = await journeys.open("/");
  const before = (await api<{ daily: { id: string } | null }>(page, "GET", "/briefings")).daily?.id ?? null;
  await api(page, "POST", "/briefings", { kind: "daily" });
  await expect.poll(async () => (await api<{ daily: { id: string } | null }>(page, "GET", "/briefings")).daily?.id ?? null, { timeout: 30_000 }).not.toBe(before);
  await page.reload();
  const area = page.getByRole("region", { name: "The Daily Briefing" });
  const card = area.locator(".daily-briefing-card");
  await expect(card).toBeVisible();
  const picked = forYou(page).locator("[data-inbox-row]").filter({ hasText: "Picked in today’s Daily Briefing" });
  await expect(picked.first()).toBeVisible();
  const pickedCount = await picked.count();

  // Every later read of the briefings fails; the next briefing written makes Home ask again.
  await page.route("**/api/v1/briefings", (route) => (route.request().method() === "GET" ? route.abort() : route.fallback()));
  await api(page, "POST", "/briefings", { kind: "manual" });
  const stalePicks = forYou(page).locator("[data-picks-stale]");
  await expect(stalePicks).toHaveText(/^Could not check the Daily Briefing again, so its picks are as read at \d{2}:\d{2}\. Retry$/, { timeout: 30_000 });
  await expect(picked).toHaveCount(pickedCount);
  const staleArea = area.locator("[data-briefing-stale]");
  await expect(staleArea).toHaveText(/^Could not check for a newer briefing; this is the one read at \d{2}:\d{2}\. Retry$/);
  await expect(card).toBeVisible();
  await expect(area).not.toContainText("Could not check for a briefing.");

  // Retry once the service answers: each line goes, and the briefing written meanwhile shows.
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await staleArea.getByRole("button", { name: "Retry" }).click();
  await expect(staleArea).toHaveCount(0);
  await expect(page.getByRole("article", { name: "Briefing you asked for" })).toBeVisible();
  await stalePicks.getByRole("button", { name: "Retry" }).click();
  await expect(stalePicks).toHaveCount(0);
  await expect(picked).toHaveCount(pickedCount);
});

test("curated list fits light, dark and narrow captures", async () => {
  const page = await journeys.open("/");
  await setCalendar(page, [{ id: "capture", summary: "Design review", start: 12, end: 45 }]);
  for (const scheme of ["light", "dark"] as const) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `test-results/screens/${scheme}-home-for-you-now.png` });
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await page.screenshot({ path: "test-results/screens/narrow-home-for-you-now.png" });
});

test("no console errors", () => expect(journeys.consoleErrors).toEqual([]));
