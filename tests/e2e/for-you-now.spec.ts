/** The Daily Briefing's own Home area, against the real bundled service and fixture Connections. */
import { test, expect, type Page } from "@playwright/test";
import { api, JourneyBrowser } from "./browser.ts";
import { buildAll, startStack, type Stack } from "./stack.ts";

let stack: Stack;
let journeys: JourneyBrowser;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  buildAll();
  stack = await startStack();
  journeys = await JourneyBrowser.start(browser, stack.url);
  const page = await journeys.newPage();
  await page.goto(stack.pairUrl());
  await expect(page.getByRole("heading", { name: "Where should Attache keep your knowledge?" })).toBeVisible();
  await api(page, "POST", "/setup/data-folder", { path: stack.dataDir });
  await api(page, "POST", "/setup/identity", { name: "Test User", email: "alex@example.com", confirm: true });
  await api(page, "POST", "/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${stack.fixtureUrl}/model`, model: "fixture-model" } });
  await api(page, "POST", "/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678" } });
  await api(page, "POST", "/connections/claude-code/configure", { method: "hooks", fields: {} });
  await api(page, "POST", "/setup/complete");
  await api(page, "POST", "/import", { path: stack.vaultDir });
  await api(page, "POST", "/connections/github/refresh");
  await expect.poll(async () => (await api<{ items: unknown[] }>(page, "GET", "/attention?state=open")).items.length, { timeout: 30_000 }).toBeGreaterThan(2);
});

test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

const area = (page: Page) => page.getByRole("region", { name: "The Daily Briefing" });
const forYou = (page: Page) => page.getByRole("region", { name: "For you now" });

async function writeBriefing(page: Page, kind: "daily" | "away" | "manual") {
  const before = (await api<{ briefing: { id: string } | null }>(page, "GET", "/briefings/latest")).briefing?.id ?? null;
  await api(page, "POST", "/briefings", { kind, ...(kind === "away" ? { since: new Date(Date.now() - 3 * 86_400_000).toISOString() } : {}) });
  await expect.poll(async () => (await api<{ briefing: { id: string } | null }>(page, "GET", "/briefings/latest")).briefing?.id ?? null, { timeout: 30_000 }).not.toBe(before);
}

test("empty, progress and switched-off states", async () => {
  const page = await journeys.open("/");
  await expect(area(page)).toContainText("No briefing yet today");
  const running = { id: "job-in-progress", kind: "briefing", title: "Briefing", status: "running", progress: 0.4, progressNote: "Composing briefing", attempts: 1, maxAttempts: 3, result: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: null, cancelRequestedAt: null, cancelOutcome: null, capability: "attention", connectionId: null };
  await page.route("**/api/v1/jobs?status=queued,running*", (route) => route.fulfill({ json: [running] }));
  await page.reload();
  await expect(area(page)).toContainText("Preparing your briefing");
  await expect(area(page).getByRole("progressbar", { name: "Briefing progress" })).toHaveAttribute("aria-valuenow", "40");
  await page.unroute("**/api/v1/jobs?status=queued,running*");
  await api(page, "PUT", "/features", { changes: { attention: false }, cascade: true });
  await page.reload();
  await expect(area(page)).toContainText("Briefings are switched off");
  await area(page).getByRole("link", { name: "Turn it on in Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/features$/);
  await api(page, "PUT", "/features", { changes: { attention: true, drafts: true }, cascade: true });
});

test("Prepare a briefing with none today writes today's Daily Briefing, so the area fills with its card", async () => {
  const page = await journeys.open("/");
  await expect(area(page)).toContainText("No briefing yet today");
  await area(page).locator(".briefing-empty").getByRole("button", { name: "Prepare a briefing" }).click();
  const card = area(page).locator(".daily-briefing-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(area(page)).not.toContainText("No briefing yet today");
  await expect(area(page).locator(".requested-briefing")).toHaveCount(0);
  expect((await api<{ daily: { kind: string } | null; requested: unknown }>(page, "GET", "/briefings")).daily?.kind).toBe("daily");
});

test("daily: own all-day card, Got it fold, and briefing page", async () => {
  const page = await journeys.open("/");
  await writeBriefing(page, "daily");
  const card = area(page).locator(".daily-briefing-card");
  await expect(card).toBeVisible();
  await expect(area(page)).toContainText("First on your list");
  await expect(forYou(page).locator('[data-heads-up="daily-briefing"]')).toHaveCount(0);
  await expect(card.locator(".briefing-painting")).toHaveAttribute("style", /\/paintings\//);
  await card.getByRole("link", { name: "Read briefing" }).click();
  await expect(page).toHaveURL(/\/briefing\/[^/]+$/);
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveText("Home/The Daily Briefing");
  for (const heading of ["First on your list", "Top to-dos", "New updates", "Your day"]) await expect(page.getByRole("heading", { name: heading })).toBeVisible();
  // Your day is live from the agenda route, not a copy kept with the briefing.
  await expect(page.getByRole("region", { name: "Your day" })).toBeVisible();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `test-results/screens/${scheme}-briefing-page.png`, fullPage: true });
  }
  await page.emulateMedia({ colorScheme: null });
  await page.goto(stack.url);
  await card.getByRole("button", { name: "Got it" }).click();
  await expect(area(page).locator(".briefing-folded")).toBeVisible();
  await page.reload();
  await expect(area(page).locator(".briefing-folded")).toBeVisible();
  await expect(area(page).locator(".daily-briefing-card")).toHaveCount(0);
  // The folded line opens it again, and that is remembered too.
  await area(page).locator(".briefing-folded").getByRole("button").click();
  await expect(area(page).locator(".daily-briefing-card")).toBeVisible();
  await page.reload();
  await expect(area(page).locator(".daily-briefing-card")).toBeVisible();
  await expect(area(page).locator(".briefing-folded")).toHaveCount(0);
});

test("the Daily Briefing stays after noon", async () => {
  const page = await journeys.open("/");
  await writeBriefing(page, "daily");
  await expect(area(page).locator(".daily-briefing-card")).toBeVisible();
  await expect(area(page).locator(".briefing-painting")).toBeVisible();
});

test("options and requested briefings live above the daily card", async () => {
  const page = await journeys.open("/");
  await area(page).getByRole("button", { name: "Briefing options" }).click();
  await expect(area(page).getByRole("group", { name: "Briefing actions" }).getByRole("button")).toHaveText([/^Prepare a briefing/, /^Away summary/, /^Meeting context/]);
  await area(page).getByRole("button", { name: /^Away summary/ }).click();
  await expect.poll(async () => (await api<{ requested: { kind: string } | null }>(page, "GET", "/briefings")).requested?.kind, { timeout: 30_000 }).toBe("away");
  await expect(area(page).locator(".requested-briefing")).toBeVisible({ timeout: 30_000 });
  // Its page is named for what it is, an Away summary, without the Daily Briefing's painting.
  await area(page).locator(".requested-briefing").getByRole("link", { name: "Read briefing" }).click();
  await expect(page.getByRole("navigation", { name: "Breadcrumb" })).toHaveText("Home/Away summary");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Away summary");
  await expect(page.getByRole("region", { name: "Away summary" })).toBeVisible();
  await expect(page.locator(".briefing-painting")).toHaveCount(0);
  await expect(page.locator(".briefing-page").getByText("Daily Briefing")).toHaveCount(0);
  await page.goBack();
  await area(page).locator(".requested-briefing").getByRole("button", { name: "Got it" }).click();
  await expect(area(page).locator(".requested-briefing")).toHaveCount(0);
});

test("narrow layout and visual captures", async () => {
  const page = await journeys.open("/");
  await writeBriefing(page, "daily");
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${width}px overflow`).toBeLessThanOrEqual(0);
    if (width === 375) await expect(area(page).locator(".briefing-painting")).toBeVisible();
    else await expect(area(page).locator(".briefing-painting")).toBeHidden();
  }
  for (const scheme of ["light", "dark"] as const) {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: scheme });
    await page.screenshot({ path: `test-results/screens/${scheme}-home-daily-briefing.png` });
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: "test-results/screens/narrow-home-daily-briefing.png" });
});

test("no console errors during the briefing journeys", () => {
  expect(journeys.consoleErrors).toEqual([]);
});
