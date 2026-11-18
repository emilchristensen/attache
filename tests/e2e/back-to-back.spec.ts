/**
 * Back-to-back meetings with the keyboard (#41 of spec #14): one journey through the rendered Home on a fixed browser
 * clock, from before the first meeting's Heads-up through the second meeting, run once with Not now and once with
 * Done. The service keeps the real clock, so the browser's starts 42 minutes before the first meeting's real end and
 * is moved forward by hand; the first meeting really ends about two minutes into the Not now run, so the count is
 * checked against the service's own end of it.
 */
import { test, expect, type Browser, type Locator, type Page } from "@playwright/test";
import { api, JourneyBrowser } from "./browser.ts";
import { buildAll, startStack, type Stack } from "./stack.ts";
import { completeRows, routeSignIn } from "./home-fold.ts";
import { area, meetingHeadsUp, MINUTE, needYou, rowFor, SELF, setCalendar } from "./meetings.ts";

let stack: Stack;
let journeys: JourneyBrowser;

/**
 * How long after the run starts the first meeting really ends, at least: room for every step before it, on a slow
 * runner too. It ends half a minute past a minute, between the For you now clock's minute ticks.
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
  // A briefing the owner asked for: the follower both meetings come in above.
  await api(page, "POST", "/briefings", { kind: "manual" });
  await expect.poll(async () => (await api<{ briefing: unknown }>(page, "GET", "/briefings/latest")).briefing !== null, { timeout: 30_000 }).toBe(true);
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

interface Pair {
  first: { id: string; subject: string; meetLink: string };
  second: { id: string; subject: string; meetLink: string };
}

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
const calendarUrl = (id: string) => `https://calendar.google.com/event?eid=${id}`;
const lead = (page: Page) => area(page).locator("article.heads-up-lead");
/** Captures the page as it is, light and dark, for the visual review. */
async function shoot(page: Page, name: string): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await settle(page);
    await page.screenshot({ path: `test-results/screens/${scheme}-${name}.png` });
  }
  await page.emulateMedia({ colorScheme: null });
}
const focusedText = (page: Page) => page.evaluate(() => document.activeElement?.textContent ?? null);

/** The meeting's destinations, as its Heads-up links them. */
async function expectDestinations(headsUp: Locator, meeting: Pair["first"]): Promise<void> {
  await expect(headsUp.getByRole("link", { name: "Open in Google Calendar" })).toHaveAttribute("href", calendarUrl(meeting.id));
  await expect(headsUp.getByRole("link", { name: "Join" })).toHaveAttribute("href", meeting.meetLink);
}

/**
 * The run up to the overlap, the same for both outcomes: the first meeting leads 15 minutes before its start, the
 * keyboard is on its Join once it runs, and 15 minutes before the second one starts that one comes in below it.
 * Returns the paired page, the instant the first meeting ends, and the count before any meeting moved up.
 */
async function toTheOverlap(browser: Browser, pair: Pair, { keyboardOnRow }: { keyboardOnRow: boolean }) {
  const own = await JourneyBrowser.start(browser, stack.url, { timezoneId: "Europe/Copenhagen", storageState: await journeys.context.storageState() });
  const page = await own.newPage();
  // The decision keys on, so the journey can show they decide nothing where a row moved up.
  if (keyboardOnRow) await page.addInitScript(() => localStorage.setItem("attache.decision-keys", "on"));
  const ends = firstEnd();
  // Before the first Heads-up: the first meeting's prep shows 40 minutes before its real end.
  await page.clock.install({ time: ends - 42 * MINUTE });
  await routeSignIn(page);
  await page.goto(stack.url);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.mouse.move(5, 5);
  await setCalendar(
    page,
    stack,
    [
      { id: pair.first.id, summary: pair.first.subject, start: -25, end: 0, meetLink: pair.first.meetLink },
      { id: pair.second.id, summary: pair.second.subject, start: 0, end: 30, meetLink: pair.second.meetLink },
    ],
    ends,
  );
  await page.reload();

  // Both meetings are Inbox rows, and nothing is promoted yet.
  await expect(rowFor(page, pair.first.id)).toBeVisible();
  await expect(rowFor(page, pair.second.id)).toBeVisible();
  await expect(area(page).locator('[data-heads-up="meeting-prep"]')).toHaveCount(0);
  await expect(page.locator("#inbox .count-line", { hasText: "above" })).toHaveCount(0);
  const base = await readCount(page);

  // Promotion: 15 minutes before its start the first meeting leads, above the briefing, and leaves the Inbox; it is
  // still one decision. With the keyboard on its row, the row's place keeps the focus, with nothing to press.
  const row = rowFor(page, pair.first.id);
  const rowHeight = (await row.boundingBox())!.height;
  if (keyboardOnRow) await row.locator("button[data-row-toggle]").focus();
  await advanceTo(page, ends - 40 * MINUTE + 1_000);
  const first = meetingHeadsUp(page, pair.first.subject);
  await expect(first).toHaveAttribute("data-meeting-phase", "upcoming");
  await expect(lead(page).locator(".heads-up-title")).toHaveText(pair.first.subject);
  await expect(area(page).locator(".heads-up-lines > li").first()).toHaveAttribute("data-heads-up", "requested-briefing");
  await expectDestinations(first, pair.first);
  if (keyboardOnRow) {
    const stand = page.locator(`#inbox [data-moved-up][data-item-key="gcal:${pair.first.id}"]`);
    await expect(stand).toBeFocused();
    await expect(stand).toHaveText(`Meeting prepMoved up to For you now: ${pair.first.subject}`);
    expect(Math.abs((await stand.boundingBox())!.height - rowHeight), "the row's place keeps its height").toBeLessThanOrEqual(1);
    await shoot(page, "home-inbox-moved-up");
    // Enter does nothing there, and the decision keys find no item to decide.
    await page.keyboard.press("Enter");
    await page.keyboard.press("d");
    await expect(stand).toBeFocused();
    await expectCount(page, base, 0);
    await expect(page.locator("#inbox").getByRole("status")).toHaveText(`${pair.first.subject} moved up to For you now.`);
    // Moving on with j goes to the next row; the place it left goes, as the meeting is shown above.
    const after = await stand.evaluate((el) => (el.nextElementSibling as HTMLElement).dataset.itemId!);
    await page.keyboard.press("j");
    await expect(page.locator("#inbox [data-moved-up]")).toHaveCount(0);
    await expect(page.locator(`#inbox [data-inbox-row][data-item-id="${after}"] button[data-row-toggle]`)).toBeFocused();
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  }
  await expect(rowFor(page, pair.first.id)).toHaveCount(0);
  await expectCount(page, base, 0);
  await expect(page.locator("#inbox .count-line")).toHaveText(/^1 meeting above · \d+ items below need you$/);

  // The first meeting starts: Join first, and the keyboard goes onto it.
  await advanceTo(page, ends - 25 * MINUTE + 1_000);
  await expect(first).toHaveAttribute("data-meeting-phase", "in-progress");
  await expect(first.locator(".heads-up-foot .heads-up-actions > *").first()).toHaveText("Join");
  await expectDestinations(first, pair.first);
  const join = first.getByRole("link", { name: "Join" });
  await join.focus();
  await join.evaluate((el) => ((el as HTMLElement & { journeyMark?: string }).journeyMark = "first-join"));
  const joinAt = (await join.boundingBox())!.y;
  const headingAt = (await area(page).getByRole("heading", { name: "For you now" }).boundingBox())!.y;

  // 15 minutes before the second one starts it comes in below the first, as a compact line, above the briefing. The
  // focus, the Join element and its destination stay on the first meeting, and nothing above the new line moves.
  await advanceTo(page, ends - 15 * MINUTE + 1_000);
  const second = meetingHeadsUp(page, pair.second.subject);
  await expect(second).toBeVisible();
  await expect(second).toHaveJSProperty("tagName", "LI");
  const lines = area(page).locator(".heads-up-lines").first().locator(":scope > li");
  await expect(lines.nth(0)).toContainText(pair.second.subject);
  await expect(lines.nth(1)).toHaveAttribute("data-heads-up", "requested-briefing");
  await expect(join).toBeFocused();
  expect(await page.evaluate(() => (document.activeElement as HTMLElement & { journeyMark?: string }).journeyMark), "the focused Join is the same element").toBe("first-join");
  await expect(join).toHaveAttribute("href", pair.first.meetLink);
  await settle(page);
  expect(Math.abs((await join.boundingBox())!.y - joinAt), "the focused Join stays put").toBeLessThanOrEqual(1);
  expect(Math.abs((await area(page).getByRole("heading", { name: "For you now" }).boundingBox())!.y - headingAt)).toBeLessThanOrEqual(1);
  // Each open meeting counts once: both are above, neither is listed below, and the count has not changed.
  await expect(rowFor(page, pair.second.id)).toHaveCount(0);
  await expect(page.locator("#inbox .count-line")).toHaveText(/^2 meetings above · \d+ items below need you$/);
  await expectCount(page, base, 0);
  return { own, page, ends, base, first, second, join };
}

test("back to back with Not now: the first meeting ends under the keyboard, Enter joins nothing, and the second takes over", async ({ browser }) => {
  test.setTimeout(300_000);
  const pair: Pair = {
    first: { id: "handover", subject: "Pilot handover", meetLink: "https://meet.google.com/pil-ot-hand" },
    second: { id: "triage", subject: "Billing triage", meetLink: "https://meet.google.com/bil-ling-tri" },
  };
  const { own, page, ends, base, first, second } = await toTheOverlap(browser, pair, { keyboardOnRow: false });

  // The fold, in both themes: the meeting in progress, the next one and the briefing as lines, one sign-in problem.
  await expect(page.getByRole("status", { name: "Connections" }).locator('.conn-row[data-state="sign_in"]')).toBeVisible();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await completeRows(page), `complete Inbox rows during back-to-back meetings, ${scheme}`).toBeGreaterThanOrEqual(1);
  }
  await page.emulateMedia({ colorScheme: null });
  await expect(first.getByRole("link", { name: "Join" })).toBeFocused();

  // The first meeting really ends, half a minute past the minute. The browser's clock stands still two seconds before
  // while the service's catches up, then runs past the end without reaching the next minute tick: its place shows
  // "Meeting ended" at the same size, the focus lands there, and Enter neither joins the next call nor anything else.
  const height = (await first.boundingBox())!.height;
  await page.clock.pauseAt(ends - 2_000);
  await expect(first.getByRole("link", { name: "Join" })).toBeFocused();
  await page.waitForTimeout(Math.max(0, ends + 1_000 - Date.now()));
  const opened: Page[] = [];
  own.context.on("page", (p) => opened.push(p));
  await page.clock.runFor(3_000);
  const ended = area(page).locator("[data-meeting-ended]");
  await expect(ended).toBeFocused();
  await page.clock.resume();
  await expect(ended).toHaveText(`Meeting ended · ${pair.first.subject}`);
  expect(Math.abs((await ended.boundingBox())!.height - height), "the ended meeting keeps its size").toBeLessThanOrEqual(1);
  await expect(area(page).getByRole("link", { name: "Join" })).toHaveCount(0);
  await expect(area(page).getByRole("status").last()).toHaveText(`${pair.first.subject} ended.`);
  await shoot(page, "home-meeting-ended");
  await expect(ended).toBeFocused();
  const at = page.url();
  await page.keyboard.press("Enter");
  await settle(page);
  expect(opened, "Enter opened no call").toEqual([]);
  expect(page.url()).toBe(at);
  await expect(ended).toBeFocused();
  // Scheduled end: the service ends the item, so it counts no more and is listed nowhere; the second still counts once.
  await expectCount(page, base, -1);
  await expect(rowFor(page, pair.first.id)).toHaveCount(0);
  await expect(rowFor(page, pair.second.id)).toHaveCount(0);
  await expect(second).toBeVisible();

  // Tab goes on to the next meeting's line, not to a Join; back out of the Heads-ups, the second meeting leads, in
  // progress, with its own call and event.
  await page.keyboard.press("Tab");
  await expect(second.getByRole("button", { name: "Open prep" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(focusedText(page)).resolves.not.toBe("Join");
  await expect(ended).toHaveCount(0);
  await expect(lead(page).locator(".heads-up-title")).toHaveText(pair.second.subject);
  await expect(second).toHaveAttribute("data-meeting-phase", "in-progress");
  await expect(second.locator(".heads-up-foot .heads-up-actions > *").first()).toHaveText("Join");
  await expectDestinations(second, pair.second);

  // Not now: the second meeting goes back to the Inbox, still one decision.
  await second.getByRole("button", { name: "Not now" }).focus();
  await page.keyboard.press("Enter");
  await expect(second).toHaveCount(0);
  await expect(area(page).getByRole("heading", { name: "For you now" })).toBeFocused();
  await expect(rowFor(page, pair.second.id)).toBeVisible();
  await expect(page.locator("#inbox .count-line", { hasText: "above" })).toHaveCount(0);
  await expectCount(page, base, -1);
  expect(opened).toEqual([]);
  expect(own.consoleErrors).toEqual([]);
  await own.close();
});

test("back to back with Done: the keyboard leaves a promoted row in place, Done decides the first, and the second takes over", async ({ browser }) => {
  test.setTimeout(180_000);
  const pair: Pair = {
    first: { id: "crit", subject: "Design crit", meetLink: "https://meet.google.com/cri-tic-now" },
    second: { id: "hiring", subject: "Hiring sync", meetLink: "https://meet.google.com/hir-ing-syn" },
  };
  const { own, page, ends, base, second, join } = await toTheOverlap(browser, pair, { keyboardOnRow: true });

  // Done on the meeting in progress, from its Join with the keyboard: it is decided on every Machine and counts no more.
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveText("Open in Google Calendar");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveText("Done");
  await page.keyboard.press("Enter");
  await expect(join).toHaveCount(0);
  await expect(area(page).getByRole("heading", { name: "For you now" })).toBeFocused();
  await expect(area(page).getByRole("status").last()).toHaveText(`${pair.first.subject} marked done, on every Machine.`);
  await expectCount(page, base, -1);
  await expect(rowFor(page, pair.first.id)).toHaveCount(0);

  // The second meeting leads, before its start with its own event and call, then in progress with Join first.
  await expect(lead(page).locator(".heads-up-title")).toHaveText(pair.second.subject);
  await expect(second).toHaveAttribute("data-meeting-phase", "upcoming");
  await expectDestinations(second, pair.second);
  await advanceTo(page, ends + 1_000);
  await expect(second).toHaveAttribute("data-meeting-phase", "in-progress");
  await expect(second.locator(".heads-up-foot .heads-up-actions > *").first()).toHaveText("Join");
  await expectDestinations(second, pair.second);
  await expect(rowFor(page, pair.second.id)).toHaveCount(0);
  await expect(page.locator("#inbox .count-line")).toHaveText(/^1 meeting above · \d+ items below need you$/);
  await expectCount(page, base, -1);

  // Done on it too: both decided, neither listed.
  await second.getByRole("button", { name: "Done" }).focus();
  await page.keyboard.press("Enter");
  await expect(second).toHaveCount(0);
  await expectCount(page, base, -2);
  await expect(rowFor(page, pair.second.id)).toHaveCount(0);
  expect(own.consoleErrors).toEqual([]);
  await own.close();
});

test("a row the keyboard is on keeps its place when its meeting moves up, under Group by type, at the meeting's end and when it is decided elsewhere", async ({ browser }) => {
  const own = await JourneyBrowser.start(browser, stack.url, { timezoneId: "Europe/Copenhagen", storageState: await journeys.context.storageState() });
  const page = await own.newPage();
  await page.clock.install({ time: new Date() });
  await page.goto(stack.url);
  await page.mouse.move(5, 5);
  const times = await setCalendar(page, stack, [
    { id: "planning", summary: "Quarterly planning", start: 180, end: 240 },
    { id: "retro", summary: "Sprint retro", start: 20, end: 50 },
  ]);
  await page.reload();
  await page.locator("#inbox").getByRole("combobox", { name: "View" }).selectOption({ label: "Group by type" });
  const meetings = page.locator('#inbox [data-family="meetings"]');
  await expect(meetings.locator(".inbox-family-count")).toHaveText("2");
  const base = await readCount(page);
  await rowFor(page, "retro").locator("button[data-row-toggle]").focus();
  // Its Heads-up comes due: the row's place stays in its family with the focus, and the family counts only the other.
  await advanceTo(page, Date.parse(times.retro!.start) - 15 * MINUTE + 1_000);
  await expect(meetingHeadsUp(page, "Sprint retro")).toBeVisible();
  const stand = meetings.locator("[data-moved-up]");
  await expect(stand).toBeFocused();
  await expect(meetings.locator(".inbox-family-count")).toHaveText("1");
  await expect(meetings.locator("[data-inbox-row]")).toHaveCount(2);
  await expectCount(page, base, 0);
  // Its scheduled end passes with the keyboard still there: the Heads-up goes, and the place stays rather than
  // turning back into a row for an ended meeting.
  await advanceTo(page, Date.parse(times.retro!.end) + 1_000);
  await expect(meetingHeadsUp(page, "Sprint retro")).toHaveCount(0);
  await expect(stand).toBeFocused();
  await expect(page.locator('#inbox [data-item-key="gcal:retro"] button[data-row-toggle]')).toHaveCount(0);
  // Done on another Machine: the item leaves the open list, and the place the keyboard is on stays.
  const id = await stand.getAttribute("data-item-id");
  await api(page, "POST", `/attention/${id}/decision`, { decision: "done" });
  await expectCount(page, base, -1);
  await expect(stand).toBeFocused();
  // The keyboard moves on: the place goes.
  await page.keyboard.press("Tab");
  await expect(page.locator("#inbox [data-moved-up]")).toHaveCount(0);
  await page.locator("#inbox").getByRole("combobox", { name: "View" }).selectOption({ label: "Priority order" });
  expect(own.consoleErrors).toEqual([]);
  await own.close();
});

test("no console errors during the back-to-back journeys", () => {
  expect(journeys.consoleErrors).toEqual([]);
});
