import { test, expect, type Page } from "@playwright/test";
import { api, JourneyBrowser } from "./browser.ts";
import { buildAll, startStack, type Stack } from "./stack.ts";
import { setCalendar as setFixtureCalendar, type Meeting } from "./meetings.ts";

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
  const suggested = forYou(page).locator("[data-inbox-row]").filter({ hasText: "Pilot handover" });
  await expect(suggested).toContainText("Starts in 10 min, prep not read");
  await expect(suggested.getByRole("button", { name: /Start working/ })).toBeVisible();
  await expect(suggested.getByRole("button", { name: /Snooze/ })).toBeVisible();
  await expect(suggested.getByRole("button", { name: /Done/ })).toBeVisible();
  await expect(itemRow(page, "Pilot handover")).toContainText("Suggested now");
  await suggested.getByRole("button", { name: /Start working/ }).click();
  await expect(suggested).toBeVisible();
  await forYou(page).getByRole("heading", { name: "For you now" }).focus();
  await page.mouse.move(2, 2);
  await expect(suggested).toHaveCount(0);
  await expect(itemRow(page, "Pilot handover")).toContainText("In progress");
});

test("started entry remains with actions and the list holds while focus is inside it", async () => {
  const page = await journeys.open("/");
  const first = forYou(page).locator("[data-inbox-row]").first();
  await expect(first).toBeVisible();
  const before = await first.getAttribute("data-item-id");
  await first.getByRole("button").first().focus();
  await page.waitForTimeout(250);
  await expect(first).toHaveAttribute("data-item-id", before!);
  await first.getByRole("button", { name: /Done/ }).click();
  await expect(forYou(page).locator(`[data-item-id="${before}"]`)).toHaveCount(1);
  await forYou(page).getByRole("heading", { name: "For you now" }).focus();
  await page.mouse.move(2, 2);
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
