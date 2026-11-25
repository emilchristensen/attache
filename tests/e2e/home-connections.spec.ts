/**
 * The Connection banner on every screen (#84 of spec #82), against the real bundled service and fixture Connections.
 * The browser answer is changed only to exercise the decision states; Reconnect and Disable call the real service routes.
 */
import { test, expect, type Page } from "@playwright/test";
import type { ConnectionStatus } from "../../packages/contracts/src/features.ts";
import { api, JourneyBrowser, nextFrames, settled } from "./browser.ts";
import { buildAll, startStack, type Stack } from "./stack.ts";
import { SELF, setCalendar } from "./meetings.ts";

let stack: Stack;
let journeys: JourneyBrowser;

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 375, height: 812 };

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  buildAll();
  stack = await startStack();
  journeys = await JourneyBrowser.start(browser, stack.url, { timezoneId: "Europe/Copenhagen", viewport: DESKTOP });
  const page = await journeys.newPage();
  await page.goto(stack.pairUrl());
  await expect(page.getByRole("heading", { name: "Where should Attache keep your knowledge?" })).toBeVisible();
  await api(page, "POST", "/setup/data-folder", { path: stack.dataDir });
  await api(page, "POST", "/setup/identity", { name: "Test User", email: SELF, confirm: true });
  await api(page, "POST", "/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${stack.fixtureUrl}/model`, model: "fixture-model" } });
  await api(page, "POST", "/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678" } });
  await api(page, "POST", "/connections/gcal/configure", { method: "claude-ai", fields: {} });
  await api(page, "POST", "/connections/claude-code/configure", { method: "hooks", fields: {} });
  await api(page, "POST", "/setup/complete");
  // This Machine reads every 30 minutes, so a failed read promises its next automatic read.
  await api(page, "PATCH", "/config", { schedules: { refreshEveryMinutes: 30, briefingAt: "08:00", briefingEnabled: false } });
  await api(page, "POST", "/import", { path: stack.vaultDir });
  await api(page, "POST", "/jobs", { kind: "source-refresh", title: "Refresh every source", input: { all: true, reason: "manual" } });
  await expect.poll(async () => (await api<{ items: unknown[] }>(page, "GET", "/attention?state=open")).items.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
  // Two overlapping meetings and a briefing the owner asked for: For you now at its tallest on an ordinary day.
  await setCalendar(page, stack, [
    { id: "handover", summary: "Pilot handover", start: -10, end: 30, meetLink: "https://meet.google.com/abc-defg-hij" },
    { id: "triage", summary: "Billing triage", start: 10, end: 50, meetLink: "https://meet.google.com/bil-ling-tri" },
  ]);
  await api(page, "POST", "/briefings", { kind: "manual" });
  await expect.poll(async () => (await api<{ briefing: unknown }>(page, "GET", "/briefings/latest")).briefing !== null, { timeout: 30_000 }).toBe(true);
  await page.close();
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

/**
 * Mixed problems from the real answer: GitHub signed out, Gmail's read failed, Slack only partly read, and Jira never
 * read. Three rows show (sign-in, down, partly read) and Jira waits behind "1 more".
 */
async function routeMixed(page: Page) {
  await page.route("**/api/v1/capabilities", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { connections: ConnectionStatus[] };
    const gh = body.connections.find((c) => c.kind === "github")!;
    const cov = gh.coverage!;
    const like = (kind: ConnectionStatus["kind"], label: string, extra: Partial<ConnectionStatus>): ConnectionStatus => ({ ...gh, id: kind, kind, label, ...extra });
    const changed = [
      { ...gh, status: "needs_auth" as const, lastError: "Bad credentials" },
      like("gmail", "Gmail", { coverage: { ...cov, state: "error", note: "GET /gmail/v1/users/me/messages → HTTP 500: backend error" } }),
      like("slack", "Slack", { coverage: { ...cov, state: "partial", note: "Mentions were read; direct messages were not" } }),
      like("jira", "Jira", { coverage: null, lastReadAt: null, lastSuccessAt: null }),
    ];
    body.connections = [...body.connections.filter((c) => !changed.some((x) => x.kind === c.kind)), ...changed];
    await route.fulfill({ response: res, json: body });
  });
}

const connections = (page: Page) => page.locator("[data-connection-banner]");

test("one issue follows every screen except Connections, names the rest, and has no close button", async () => {
  const page = await journeys.open("/");
  await routeMixed(page);
  await page.reload();
  const banner = connections(page);
  await expect(banner).toContainText("GitHub · Sign-in needed · Reviews may be missing");
  await expect(banner.getByRole("link", { name: "3 more connection issues" })).toBeVisible();
  await expect(banner.getByRole("button", { name: /close/i })).toHaveCount(0);
  for (const path of ["/approvals", "/brain", "/jobs", "/settings"]) {
    await page.goto(`${stack.url}${path}`);
    await expect(banner).toBeVisible();
  }
  await page.goto(`${stack.url}/connections`);
  await expect(banner).toHaveCount(0);
});

test("Reconnect lands on the Connection and Disable confirms before removing its issue", async () => {
  const page = await journeys.open("/");
  let disabled = false;
  await page.route("**/api/v1/capabilities", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { connections: Array<{ id: string; status: string; lastError: string | null }> };
    if (!disabled) body.connections = body.connections.map((c) => (c.id === "github" ? { ...c, status: "needs_auth", lastError: "Bad credentials" } : c));
    await route.fulfill({ response: res, json: body });
  });
  await page.reload();
  const banner = connections(page);
  await banner.getByRole("button", { name: "Reconnect" }).click();
  await expect(page).toHaveURL(/\/connections\?open=github$/);
  await page.goto(`${stack.url}/`);
  await banner.getByRole("button", { name: "Disable" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Disable" });
  await expect(confirm).toContainText("Disable GitHub?");
  await expect(confirm).toContainText(/queued jobs? will be cancelled/);
  await Promise.all([page.waitForResponse((res) => res.url().endsWith("/connections/github/disconnect") && res.request().method() === "POST"), confirm.getByRole("button", { name: "Disable, keep data" }).click()]);
  disabled = true;
  await page.reload();
  await expect(banner).toHaveCount(0);
  await expect(page.locator(".masthead-nav").getByRole("link", { name: /^Connections/ })).toHaveAccessibleName("Connections");
});

test("the healthy masthead has a green dot and no banner", async () => {
  const page = await journeys.open("/");
  await expect(connections(page)).toHaveCount(0);
  await expect(page.locator(".masthead-nav").getByRole("link", { name: "Connections" }).locator(".connection-healthy-dot")).toBeVisible();
});

test("at 375px the fixing action stays visible and secondary choices use one menu without sideways scroll", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize(PHONE);
  await routeMixed(page);
  await page.reload();
  const banner = connections(page);
  await expect(banner.getByRole("button", { name: "Reconnect" })).toBeVisible();
  await expect(banner.locator(".connection-banner-secondary")).toBeHidden();
  const menu = banner.locator(".connection-banner-menu");
  await expect(menu).toBeVisible();
  const actions = menu.getByRole("button", { name: "Connection issue actions" });
  // A plain list under the button: Escape and a tap outside close it, with focus back on Actions.
  await actions.click();
  await expect(actions).toHaveAttribute("aria-expanded", "true");
  await expect(menu.getByRole("group", { name: "Connection issue actions" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu.getByRole("button", { name: "Disable" })).toHaveCount(0);
  await expect(actions).toBeFocused();
  await actions.click();
  await page.mouse.click(5, 400);
  await expect(menu.getByRole("button", { name: "Disable" })).toHaveCount(0);
  await actions.click();
  await expect(menu.getByRole("button", { name: "Disable" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settled(page);
    await page.screenshot({ path: `test-results/screens/${scheme}-connection-banner-narrow.png` });
  }
});

test("a screen reader hears each new issue once: the shell's live region is there from the start and changes only with the issue", async () => {
  const page = await journeys.open("/");
  // Every text the region takes, and whether it was in the page before the banner first showed.
  await page.addInitScript(() => {
    const log = { texts: [] as string[], before: false };
    (window as unknown as { announced: typeof log }).announced = log;
    new MutationObserver(() => {
      const region = document.querySelector("[data-banner-announcement]");
      if (region && !document.querySelector("[data-connection-banner]")) log.before = true;
      const text = region?.textContent ?? "";
      if (text && log.texts.at(-1) !== text) log.texts.push(text);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  const announced = () => page.evaluate(() => (window as unknown as { announced: { texts: string[]; before: boolean } }).announced);
  let signedOut = "github";
  await page.route("**/api/v1/capabilities", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { connections: ConnectionStatus[] };
    body.connections = body.connections.map((c) => (c.kind === signedOut ? { ...c, status: "needs_auth" as const, lastError: "Bad credentials" } : c));
    await route.fulfill({ response: res, json: body });
  });
  await page.reload();
  const region = page.locator("[data-banner-announcement]");
  await expect(region).toHaveAttribute("role", "status");
  await expect(region).toHaveText(/^GitHub · Sign-in needed/);
  // A refresh that leaves the issue the same changes nothing a screen reader would hear.
  const asked = () => page.waitForResponse((r) => r.url().endsWith("/api/v1/capabilities"));
  let answered = asked();
  await api(page, "PATCH", "/config", { schedules: { refreshEveryMinutes: 30, briefingAt: "08:00", briefingEnabled: false } });
  await answered;
  await nextFrames(page);
  expect(await announced()).toEqual({ texts: [expect.stringMatching(/^GitHub · Sign-in needed/)], before: true });
  // A new issue is heard once.
  signedOut = "gcal";
  answered = asked();
  await api(page, "PATCH", "/config", { schedules: { refreshEveryMinutes: 30, briefingAt: "08:00", briefingEnabled: false } });
  await answered;
  await expect(region).toHaveText(/^Google Calendar · Sign-in needed/);
  expect((await announced()).texts).toEqual([expect.stringMatching(/^GitHub · Sign-in needed/), expect.stringMatching(/^Google Calendar · Sign-in needed/)]);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a failure that lasts only a moment never raises the banner; one that lasts does, and it clears on its own", async () => {
  const page = await journeys.open("/");
  // Every state the banner takes from the first paint on, so a banner that flashes for a moment is caught too.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { bannerStates: string[] }).bannerStates = seen;
    new MutationObserver(() => {
      const state = document.querySelector("[data-connection-banner]")?.getAttribute("data-state");
      if (state && seen.at(-1) !== state) seen.push(state);
    }).observe(document, { subtree: true, childList: true, attributes: true });
  });
  const unavailable = { status: 503, json: { error: { code: "unavailable", message: "The service is busy" } } };
  const bannerStates = () => page.evaluate(() => (window as unknown as { bannerStates: string[] }).bannerStates);

  // One failed answer, then good ones: Attache asks again on its own and the banner never shows.
  let failures = 1;
  await page.route("**/api/v1/capabilities", (route) => (failures-- > 0 ? route.fulfill(unavailable) : route.fallback()));
  const recovered = page.waitForResponse((r) => r.url().endsWith("/api/v1/capabilities") && r.status() === 200, { timeout: 30_000 });
  await page.reload();
  await recovered;
  await expect(page.locator(".masthead-nav").getByRole("link", { name: "Connections" }).locator(".connection-healthy-dot")).toBeVisible();
  await nextFrames(page);
  expect(await bannerStates()).toEqual([]);
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // A failure that persists raises Could not check, only after it has lasted a while, and goes once an answer comes.
  await page.route("**/api/v1/capabilities", (route) => route.fulfill(unavailable));
  const firstFailure = page.waitForResponse((r) => r.url().endsWith("/api/v1/capabilities") && r.status() === 503);
  await page.reload();
  await firstFailure;
  const failedAt = Date.now();
  const failed = page.locator('[data-connection-banner][data-state="could_not_check"]');
  await expect(failed).toContainText("Could not check");
  expect(Date.now() - failedAt).toBeGreaterThanOrEqual(4_000);
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await expect(failed).toHaveCount(0, { timeout: 30_000 });
});

test("no unresolved console errors across the Connection banner journeys", () => {
  expect(journeys.consoleErrors).toEqual([]);
});
