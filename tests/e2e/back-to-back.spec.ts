/**
 * Back-to-back meetings in For you now (spec #82): one journey through the rendered Home on a fixed browser clock,
 * from before the first meeting's prep is due through its end, and the row actions on an entry with Undo. The service
 * keeps the real clock, so the browser's starts 42 minutes before the first meeting's real end and is moved forward
 * by hand; the first meeting really ends about two minutes into the run, so the count is checked against the
 * service's own end of it.
 */
import { test, expect, type Page } from "@playwright/test";
import { api, JourneyBrowser } from "./browser.ts";
import { buildAll, startStack, type Stack } from "./stack.ts";
import { completeRows, routeSignIn } from "./home-fold.ts";
import { rowAction } from "./inbox.ts";
import { area, meetingHeadsUp, MINUTE, needYou, rowFor, SELF, setCalendar } from "./meetings.ts";

let stack: Stack;
let journeys: JourneyBrowser;

/**
 * How long after the run starts the first meeting really ends, at least: room for every step before it, on a slow
 * runner too. It ends half a minute past a minute, between Home's clock's minute ticks.
 */
const FIRST_ENDS_AFTER_MS = 1.5 * MINUTE;
const firstEnd = () => Math.ceil((Date.now() + FIRST_ENDS_AFTER_MS) / MINUTE) * MINUTE + 30_000;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  buildAll();
  stack = await startStack();
  journeys = await JourneyBrowser.start(browser, stack.url, { timezoneId: "Europe/Copenhagen" });
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
  await api(page, "PATCH", "/config", { schedules: { refreshEveryMinutes: 30, briefingAt: "08:00", briefingEnabled: false } });
  await api(page, "POST", "/import", { path: stack.vaultDir });
  await api(page, "POST", "/connections/github/refresh");
  await expect.poll(async () => (await api<{ items: unknown[] }>(page, "GET", "/attention?state=open")).items.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(4);
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

/** The Inbox heading's count, as the owner reads it: a number, exact or a lower bound. */
async function readCount(page: Page): Promise<{ atLeast: boolean; n: number }> {
  const words = (await needYou(page).textContent()) ?? "";
  const m = /(At least )?(\d+) needs? you here/.exec(words);
  if (!m) throw new Error(`No count in "${words}"`);
  return { atLeast: !!m[1], n: Number(m[2]) };
}
const expectCount = (page: Page, base: { atLeast: boolean; n: number }, change: number) => expect.poll(() => readCount(page), { timeout: 30_000 }).toEqual({ atLeast: base.atLeast, n: base.n + change });

/** Moves the browser's clock on to `at`, firing the timers due on the way once. */
async function advanceTo(page: Page, at: number): Promise<void> {
  const now = await page.evaluate(() => Date.now());
  await page.clock.fastForward(Math.max(0, Math.round(at - now)));
}

const settle = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));

/** Captures the page as it is, light and dark, for the visual review. */
async function shoot(page: Page, name: string): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    await page.screenshot({ path: `test-results/screens/${scheme}-${name}.png` });
  }
  await page.emulateMedia({ colorScheme: null });
}

test("back to back: each prep comes 15 minutes before its meeting, the next one waits while the keyboard is in the list, and each leaves at its meeting's end", async ({ browser }) => {
  // The service keeps the real clock, so this run waits in real time for the first meeting's real end:
  // `FIRST_ENDS_AFTER_MS` plus up to a minute of rounding (about 2.6 minutes in all locally), past the 2-minute default.
  test.setTimeout(300_000);
  const own = await JourneyBrowser.start(browser, stack.url, { timezoneId: "Europe/Copenhagen", storageState: await journeys.context.storageState() });
  const page = await own.newPage();
  const ends = firstEnd();
  await page.clock.install({ time: ends - 42 * MINUTE });
  await routeSignIn(page);
  await page.goto(stack.url);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.mouse.move(5, 5);
  await setCalendar(
    page,
    stack,
    [
      { id: "handover", summary: "Pilot handover", start: -25, end: 0, meetLink: "https://meet.google.com/pil-ot-hand" },
      { id: "triage", summary: "Billing triage", start: 0, end: 30, meetLink: "https://meet.google.com/bil-ling-tri" },
    ],
    ends,
  );
  await page.reload();

  // Before: both meetings are Inbox rows, and neither is in For you now.
  await expect(rowFor(page, "handover")).toBeVisible();
  await expect(rowFor(page, "triage")).toBeVisible();
  await expect(area(page).locator('[data-type="meeting_prep"]')).toHaveCount(0);
  const base = await readCount(page);

  // 15 minutes before it starts the first prep is in For you now with its reason; its row stays in the Inbox, marked
  // Suggested now, and it is still one decision.
  await advanceTo(page, ends - 40 * MINUTE + 1_000);
  const first = meetingHeadsUp(page, "Pilot handover");
  await expect(first.locator(".inbox-source")).toContainText("Starts in 15 min, prep not read");
  await expect(rowFor(page, "handover")).toContainText("Suggested now");
  await expectCount(page, base, 0);

  // It starts: the reason says so, and Your day marks it in progress with Join.
  await advanceTo(page, ends - 25 * MINUTE + 1_000);
  await expect(first.locator(".inbox-source")).toContainText("Meeting started, prep not read");
  const day = page.getByRole("region", { name: "Your day" });
  await expect(day.locator('.your-day-wide [data-phase="in-progress"]')).toContainText("Pilot handover");
  await expect(day.locator('.your-day-wide [data-phase="in-progress"]').getByRole("link", { name: "Join" })).toHaveAttribute("href", "https://meet.google.com/pil-ot-hand");

  // The keyboard is in the list when the second prep comes due: nothing moves under it, and the second comes in once
  // the keyboard leaves.
  const start = await rowAction(first, "Start working");
  await start.focus();
  const at = (await start.boundingBox())!.y;
  await advanceTo(page, ends - 15 * MINUTE + 1_000);
  await settle(page);
  const second = meetingHeadsUp(page, "Billing triage");
  await expect(second).toHaveCount(0);
  await expect(start).toBeFocused();
  expect(Math.abs((await start.boundingBox())!.y - at), "the focused entry stays put").toBeLessThanOrEqual(1);
  // The pointer that opened the entry's actions leaves too.
  await page.mouse.move(5, 5);
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await expect(second.locator(".inbox-source")).toContainText("Starts in 15 min, prep not read");
  await expect(rowFor(page, "triage")).toContainText("Suggested now");
  await expectCount(page, base, 0);

  // The fold at the overlap, in both themes, with one sign-in problem in the banner: the first Inbox row is whole.
  await expect(page.locator('[data-connection-banner][data-state="sign_in"]')).toBeVisible();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await completeRows(page), `complete Inbox rows during back-to-back meetings, ${scheme}`).toBeGreaterThanOrEqual(1);
  }
  await page.emulateMedia({ colorScheme: null });
  await shoot(page, "home-back-to-back");

  // Open prep on the second: its prep opens in place, and once the pointer leaves it is off the list; its row stays in
  // the Inbox, in progress.
  await (await rowAction(second, "Start working")).click();
  await expect(second.locator("[data-meeting-detail] .meeting-prep-who")).toContainText("With Nora Lind");
  await page.mouse.move(5, 5);
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await expect(second).toHaveCount(0);
  await expect(rowFor(page, "triage")).toContainText("In progress");
  await expectCount(page, base, 0);

  // The first meeting really ends, half a minute past the minute. The browser's clock stands still two seconds before
  // while the service's catches up, then runs past the end: the prep leaves For you now and the Inbox at that instant,
  // and once the service has ended the item it counts no more.
  await page.clock.pauseAt(ends - 2_000);
  await page.waitForTimeout(Math.max(0, ends + 1_000 - Date.now()));
  await page.clock.runFor(3_000);
  await page.clock.resume();
  await expect(first).toHaveCount(0);
  await expect(rowFor(page, "handover")).toHaveCount(0);
  await expectCount(page, base, -1);
  await expect(rowFor(page, "triage")).toBeVisible();
  expect(own.consoleErrors).toEqual([]);
  await own.close();
});

test("Done from a For you now entry leaves a line with Undo in its place, and Undo brings the entry and its Inbox row back", async () => {
  const page = await journeys.open("/");
  await setCalendar(page, stack, [{ id: "crit", summary: "Design crit", start: 10, end: 40, meetLink: "https://meet.google.com/cri-tic-now" }]);
  // Loaded afresh, so the new item is an Inbox row rather than waiting behind Show new items.
  await page.reload();
  const entry = meetingHeadsUp(page, "Design crit");
  await expect(entry).toBeVisible();
  const base = await readCount(page);
  await (await rowAction(entry, "Done")).click();
  const line = area(page).locator('[data-decided="done"]');
  await expect(line).toContainText("Done: Design crit");
  await expectCount(page, base, -1);
  await expect(rowFor(page, "crit")).toHaveCount(0);
  await line.getByRole("button", { name: "Undo" }).click();
  await expect(line).toHaveCount(0);
  await expect(entry).toBeVisible();
  await expect(rowFor(page, "crit")).toBeVisible();
  await expectCount(page, base, 0);
});

test("no console errors during the back-to-back journeys", () => {
  expect(journeys.consoleErrors).toEqual([]);
});
