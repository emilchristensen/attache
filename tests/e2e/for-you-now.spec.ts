/**
 * For you now (#25 of spec #14): Home's Heads-ups, driven through the Dashboard against the real bundled service and
 * the TEST-ONLY fixtures. The browser runs in a zone where it is morning now, so a daily briefing written now is
 * this morning's; the browser clock moves past noon to show the briefing leave.
 */
import { test, expect, type Page } from "@playwright/test";
import { api, JourneyBrowser } from "./browser.ts";
import { buildAll, startStack, type Stack } from "./stack.ts";

let stack: Stack;
let journeys: JourneyBrowser;

/** A fixed-offset zone where the hour is 09 now, so noon is at least two hours away whenever the suite runs. */
function morningZone(): string {
  const offset = ((9 - new Date().getUTCHours() + 36) % 24) - 12;
  return offset === 0 ? "Etc/GMT" : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  buildAll();
  stack = await startStack();
  journeys = await JourneyBrowser.start(browser, stack.url, { timezoneId: morningZone() });
  // A finished setup with GitHub and a notes folder, so the Inbox has review requests and deadlines.
  const page = await journeys.newPage();
  await page.goto(stack.pairUrl());
  await expect(page.getByRole("heading", { name: "Where should Attache keep your knowledge?" })).toBeVisible();
  await api(page, "POST", "/setup/data-folder", { path: stack.dataDir });
  await api(page, "POST", "/setup/identity", { name: "Test User", email: "alex@example.com", confirm: true });
  await api(page, "POST", "/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${stack.fixtureUrl}/model`, model: "fixture-model" } });
  await api(page, "POST", "/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678" } });
  await api(page, "POST", "/setup/complete");
  await api(page, "POST", "/import", { path: stack.vaultDir });
  await api(page, "POST", "/connections/github/refresh");
  await expect.poll(async () => (await api<{ items: unknown[] }>(page, "GET", "/attention?state=open")).items.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

const area = (page: Page) => page.getByRole("region", { name: "For you now" });

/** Ask for a briefing of `kind` and wait until it is the latest. */
async function writeBriefing(page: Page, kind: "daily" | "away" | "manual"): Promise<string> {
  const before = (await api<{ briefing: { id: string } | null }>(page, "GET", "/briefings/latest")).briefing?.id ?? null;
  await api(page, "POST", "/briefings", { kind, ...(kind === "away" ? { since: new Date(Date.now() - 3 * 86_400_000).toISOString() } : {}) });
  let id = before;
  await expect.poll(async () => (id = (await api<{ briefing: { id: string } | null }>(page, "GET", "/briefings/latest")).briefing?.id ?? null), { timeout: 30_000 }).not.toBe(before);
  return id!;
}

/**
 * For you now's share of the first 1280 x 800 viewport, with disclosures closed. Home's other parts take the rest:
 * masthead 74, page top 24, the Home heading and search field (#21) about 120, the Connections line (#22) about 72,
 * the Inbox heading and its count line about 66, and typed rows (#23) about 70 each. So two complete rows fit under an
 * unread briefing, and four once it is put away. The rows themselves are measured once #22 and #23 are on Home.
 */
const BUDGET = { unread: 230, putAway: 90 };

async function areaHeight(page: Page): Promise<number> {
  return Math.round((await area(page).boundingBox())!.height);
}

test("quiet: with nothing timely the area is one line, and the briefing actions are there", async () => {
  const page = await journeys.open("/");
  const forYou = area(page);
  await expect(forYou).toHaveAttribute("data-for-you-now", "quiet");
  // The scheduler's next run, an instant, said in the browser's zone.
  const { schedules } = await api<{ schedules: Array<{ jobKind: string; nextRunAt: string }> }>(page, "GET", "/status");
  const next = new Date(schedules.find((x) => x.jobKind === "briefing")!.nextRunAt);
  const clock = await page.evaluate((iso) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }), next.toISOString());
  await expect(forYou.locator(".for-you-now-quiet-text")).toHaveText(new RegExp(`^Nothing timely right now\\. The (next )?daily briefing is scheduled (for ${clock}( tomorrow)?|on \\d+ \\w+ at ${clock})\\.$`));
  await forYou.getByRole("button", { name: "Briefings" }).click();
  const menu = forYou.getByRole("group", { name: "Briefing actions" });
  await expect(menu.getByRole("button")).toHaveText([/^Prepare a briefing/, /^Away summary/, /^Meeting context/]);
  // Meeting context reads the latest briefing, and there is none yet.
  await expect(menu.getByRole("button", { name: /^Meeting context/ })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(forYou.getByRole("button", { name: "Briefings" })).toBeFocused();
});

test("morning: the daily briefing leads with one development, its why, Read briefing and Got it", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 1280, height: 800 });
  await writeBriefing(page, "daily");
  const lead = area(page).locator('[data-heads-up="daily-briefing"]');
  await expect(lead).toBeVisible();
  await expect(lead.locator(".heads-up-eyebrow")).toHaveText("Morning briefing · Until noon");
  await expect(lead.getByRole("heading", { level: 3 })).not.toBeEmpty();
  await expect(lead.locator(".heads-up-why")).toHaveText(/^Written at \d\d:\d\d for this morning\. It leaves at noon, or when you press Got it\.$/);
  // The amber spread, with its sun.
  expect(await lead.evaluate((el) => getComputedStyle(el, "::after").content)).toBe('""');
  // Its share of the first viewport leaves room for the Inbox heading and two complete rows.
  expect(await areaHeight(page), "For you now with an unread briefing").toBeLessThanOrEqual(BUDGET.unread);
  // Read briefing opens every point, the linked counts and the file, in place.
  await lead.getByRole("button", { name: "Read briefing" }).click();
  await expect(lead.getByRole("button", { name: "Read briefing" })).toHaveAttribute("aria-expanded", "true");
  await expect(lead.locator(".briefing-lines li").first()).toBeVisible();
  await expect(lead.getByRole("group", { name: "Briefing at a glance" })).toBeVisible();
  await lead.getByRole("button", { name: "Open the full briefing" }).click();
  await expect(page.getByRole("dialog", { name: /Evidence/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await lead.getByRole("button", { name: "Read briefing" }).click();
  await expect(lead.locator(".briefing-detail")).toHaveCount(0);
});

test("look: a control on the amber spread keeps a 3:1 edge and focus ring, in light and dark", async () => {
  const page = await journeys.open("/");
  const lead = area(page).locator('[data-heads-up="daily-briefing"]');
  await lead.getByRole("button", { name: "Read briefing" }).click();
  const control = lead.getByRole("button", { name: "Open the full briefing" });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const measured = await control.evaluate(async (el) => {
      const rgb = (c: string) => {
        const [r, g, b] = c.match(/\d+(\.\d+)?/g)!.map(Number) as [number, number, number];
        return { r, g, b };
      };
      const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
        const lin = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      };
      const ratio = (a: string, b: string) => {
        const [hi, lo] = [lum(rgb(a)), lum(rgb(b))].sort((x, y) => y - x) as [number, number];
        return (hi + 0.05) / (lo + 0.05);
      };
      const spread = getComputedStyle(el.closest(".heads-up-lead")!).backgroundColor;
      (el as HTMLElement).focus();
      await new Promise((r) => requestAnimationFrame(r));
      const style = getComputedStyle(el);
      return { edge: ratio(style.borderTopColor, spread), ring: ratio(style.outlineColor, spread), ringWidth: parseFloat(style.outlineWidth) };
    });
    expect(measured.edge, `${scheme} control edge on the spread`).toBeGreaterThanOrEqual(3);
    expect(measured.ring, `${scheme} focus ring on the spread`).toBeGreaterThanOrEqual(3);
    expect(measured.ringWidth).toBe(3);
  }
  await page.emulateMedia({ colorScheme: null });
});

test("progress: a briefing being written shows as a line with its why while the job runs", async () => {
  const page = await journeys.open("/");
  const running = { id: "job-in-progress", kind: "briefing", title: "Briefing", status: "running", progress: 0.4, progressNote: "Composing briefing", attempts: 1, maxAttempts: 3, result: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: null, cancelRequestedAt: null, cancelOutcome: null, capability: "attention", connectionId: null };
  await page.route("**/api/v1/jobs?status=queued,running*", (route) => route.fulfill({ json: [running] }));
  await page.reload();
  const line = area(page).locator('[data-heads-up="briefing-progress"]');
  await expect(line).toContainText("Preparing a briefing · 40% · Composing briefing");
  await expect(line).toContainText("Here while the briefing is written. It keeps running if you close this tab.");
  await expect(line.getByRole("progressbar", { name: "Briefing progress" })).toHaveAttribute("aria-valuenow", "40");
  // While one is written, another waits.
  await area(page).getByRole("button", { name: "Briefings" }).click();
  await expect(area(page).getByRole("button", { name: /^Prepare a briefing/ })).toBeDisabled();
  await page.unroute("**/api/v1/jobs?status=queued,running*");
  await page.reload();
  await expect(area(page).locator('[data-heads-up="briefing-progress"]')).toHaveCount(0);
});

test("Got it: the briefing shrinks to one Earlier today line, remembered in this browser, and the Inbox moves up", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 1280, height: 800 });
  const forYou = area(page);
  await forYou.locator('[data-heads-up="daily-briefing"]').getByRole("button", { name: "Got it" }).click();
  await expect(forYou.locator('[data-heads-up="daily-briefing"]')).toHaveCount(0);
  const earlier = forYou.locator('[data-heads-up="earlier-today"]');
  await expect(earlier).toContainText(/Daily briefing · Earlier today, \d\d:\d\d/);
  await expect(earlier).toContainText("It stays here until midnight while it is the latest briefing.");
  // Focus lands on the area's heading, not on the page's start, and the change is said once.
  await expect(forYou.getByRole("heading", { name: "For you now" })).toBeFocused();
  await expect(forYou.getByRole("status").last()).toHaveText("Briefing put away. It stays under Earlier today until midnight.");
  // Earlier today reopens the briefing in place.
  await earlier.getByRole("button", { name: "Read briefing" }).click();
  await expect(earlier.locator(".briefing-lines li").first()).toBeVisible();
  await earlier.getByRole("button", { name: "Read briefing" }).click();
  // Put away, it leaves room for four complete rows.
  expect(await areaHeight(page), "For you now with the briefing put away").toBeLessThanOrEqual(BUDGET.putAway);
  // Remembered in this browser, so a reload keeps it put away.
  await page.reload();
  await expect(area(page).locator('[data-heads-up="earlier-today"]')).toBeVisible();
  await expect(area(page).locator('[data-heads-up="daily-briefing"]')).toHaveCount(0);
});

test("noon: a new daily briefing leaves at noon, but not while the pointer is on it", async ({ browser }) => {
  // The browser clock is the whole context's, so this journey has a paired context of its own.
  const own = await JourneyBrowser.start(browser, stack.url, { timezoneId: morningZone(), storageState: await journeys.context.storageState() });
  const page = await own.newPage();
  await page.clock.install({ time: new Date() });
  await page.goto(stack.url);
  await page.setViewportSize({ width: 1280, height: 800 });
  await writeBriefing(page, "daily");
  const lead = area(page).locator('[data-heads-up="daily-briefing"]');
  await expect(lead).toBeVisible();
  // The pointer rests on the briefing while noon passes: it holds still.
  await lead.hover();
  await page.clock.fastForward("03:00:00");
  await expect(lead).toBeVisible();
  // The pointer leaves: the briefing becomes its Earlier today line.
  await page.mouse.move(5, 5);
  await expect(lead).toHaveCount(0);
  await expect(area(page).locator('[data-heads-up="earlier-today"]')).toBeVisible();
  expect(own.consoleErrors).toEqual([]);
  await own.close();
});

test("asked for: an Away summary leads on paper, without the amber spread, until Got it", async () => {
  const page = await journeys.open("/");
  const forYou = area(page);
  await forYou.getByRole("button", { name: "Briefings" }).click();
  await forYou.getByRole("button", { name: /^Away summary/ }).click();
  await expect(page.getByText("Writing an Away summary in the background")).toBeVisible();
  const lead = forYou.locator('[data-heads-up="away-summary"]');
  await expect(lead).toBeVisible({ timeout: 30_000 });
  await expect(lead.locator(".heads-up-eyebrow")).toHaveText(/^Away summary · Until \d\d:\d\d$/);
  await expect(lead.locator(".heads-up-why")).toHaveText(/^You asked for it at \d\d:\d\d\. It leaves at \d\d:\d\d, or when you press Got it\.$/);
  expect(await lead.evaluate((el) => el.classList.contains("feature"))).toBe(false);
  // The daily briefing is no longer the latest, so its Earlier today line has gone.
  await expect(forYou.locator('[data-heads-up="earlier-today"]')).toHaveCount(0);
  // Meeting context reads this briefing now.
  await forYou.getByRole("button", { name: "Briefings" }).click();
  await forYou.getByRole("button", { name: /^Meeting context/ }).click();
  const context = page.getByRole("region", { name: "Meeting context" });
  await expect(context).toContainText(/As the briefing at \d\d:\d\d found it/);
  await context.getByRole("button", { name: "Close" }).click();
  await expect(context).toHaveCount(0);
  await lead.getByRole("button", { name: "Got it" }).click();
  await expect(forYou).toHaveAttribute("data-for-you-now", "quiet");
});

test("failure: a briefing that could not be checked says so with Try again, never that nothing is timely", async () => {
  const page = await journeys.newPage();
  for (const p of journeys.context.pages()) if (p !== page) await p.close();
  await page.route("**/api/v1/briefings/latest", (route) => route.abort());
  await page.goto(stack.url);
  const forYou = area(page);
  await expect(forYou).toContainText("Could not check for a briefing.");
  await expect(forYou).not.toContainText("Nothing timely");
  await page.unroute("**/api/v1/briefings/latest");
  await forYou.getByRole("button", { name: "Try again" }).click();
  await expect(forYou).toContainText("Nothing timely right now.");
  await page.close();
});

test("hold: a briefing written elsewhere waits while the keyboard focus is on the lead", async () => {
  const page = await journeys.open("/");
  await writeBriefing(page, "daily");
  const daily = area(page).locator('[data-heads-up="daily-briefing"]');
  await daily.getByRole("button", { name: "Read briefing" }).focus();
  // Another Machine or tab asks for a briefing: it becomes the latest, but the focused lead stays put.
  await writeBriefing(page, "manual");
  await page.waitForTimeout(1500);
  await expect(daily).toBeVisible();
  await expect(daily.getByRole("button", { name: "Read briefing" })).toBeFocused();
  // Focus leaves: the briefing asked for takes the lead.
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await expect(area(page).locator('[data-heads-up="requested-briefing"]')).toBeVisible();
  await expect(daily).toHaveCount(0);
});

test("narrow: the lead and its lines fit a phone with no sideways scrolling", async () => {
  const page = await journeys.open("/");
  await writeBriefing(page, "daily");
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    await expect(area(page).locator('[data-heads-up="daily-briefing"]')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `${width} px overflow`).toBeLessThanOrEqual(0);
    const clipped = await area(page).evaluate((el) => [...el.querySelectorAll("h3, p, button")].filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent));
    expect(clipped, `${width} px clipped text`).toEqual([]);
  }
});

test("captures: For you now in the morning, after Got it and quiet, light, dark and narrow", async () => {
  const page = await journeys.open("/");
  const shoot = async (name: string) => {
    for (const scheme of ["light", "dark"] as const) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `test-results/screens/${scheme}-home-${name}.png` });
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `test-results/screens/narrow-home-${name}.png` });
  };
  await expect(area(page).locator('[data-heads-up="daily-briefing"]')).toBeVisible();
  await shoot("morning");
  await area(page).getByRole("button", { name: "Got it" }).click();
  await shoot("earlier-today");
  await page.setViewportSize({ width: 1280, height: 800 });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await area(page).getByRole("button", { name: "Briefings" }).click();
    await expect(area(page).getByRole("group", { name: "Briefing actions" })).toBeVisible();
    await page.screenshot({ path: `test-results/screens/${scheme}-home-briefing-actions.png` });
    await page.keyboard.press("Escape");
  }
  await page.emulateMedia({ colorScheme: null });
});

test("off: with Attention and briefings switched off the area says so, with a way to Settings", async () => {
  const page = await journeys.open("/");
  await api(page, "PUT", "/features", { changes: { attention: false }, cascade: true });
  await page.reload();
  const forYou = area(page);
  await expect(forYou).toHaveAttribute("data-for-you-now", "off");
  await expect(forYou).toContainText("Heads-ups need Attention and briefings, which is switched off.");
  await forYou.getByRole("link", { name: "Turn it on in Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await api(page, "PUT", "/features", { changes: { attention: true, drafts: true }, cascade: true });
});

test("no console errors during the For you now journeys", () => {
  expect(journeys.consoleErrors).toEqual([]);
});
