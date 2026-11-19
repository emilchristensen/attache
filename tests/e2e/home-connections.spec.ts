/**
 * Mixed Connection problems on Home (#38 of spec #14): with a sign-in, a failed read and a partly read source at once,
 * each problem keeps its source, state word and impact on one collapsed line, Reconnect stays on the line, every
 * affected source is named while the area is closed, and each row opens its detail in place from the keyboard. The
 * collapsed area leaves the Inbox higher than the open one at 1280 x 800 and 375 x 812, and with overlapping meetings,
 * a briefing follower and one collapsed sign-in the first typed Inbox row is still whole at 1280 x 800. Runs against
 * the real bundled service and the TEST-ONLY fixtures; the Connections answer is the real one with sources changed.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import type { ConnectionStatus } from "../../packages/contracts/src/features.ts";
import { api, JourneyBrowser } from "./browser.ts";
import { buildAll, startStack, type Stack } from "./stack.ts";
import { SELF, setCalendar } from "./meetings.ts";
import { completeRows, routeSignIn } from "./home-fold.ts";

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

const connections = (page: Page) => page.getByRole("status", { name: "Connections" });
const row = (page: Page, subject: string) => connections(page).locator(`.conn-row[data-subject="${subject}"]`);
const toggle = (r: Locator) => r.locator("button.conn-row-line");
const moreSummary = (page: Page) => connections(page).locator(".conn-more > summary");
const inboxHeadingTop = (page: Page) => page.locator("#inbox h2").first().evaluate((h) => h.getBoundingClientRect().top + document.querySelector(".page")!.scrollTop);

/** Every source the mixed answer affects, and the line the owner reads for it while the area is closed. */
const SHOWN = [
  { subject: "GitHub", state: "sign_in", line: "GitHub · Sign-in needed · Reviews may be missing" },
  { subject: "Gmail", state: "down", line: "Gmail · Down · Replies may be missing" },
  { subject: "Slack", state: "partial", line: "Slack · Partly read · Replies and mentions may be missing" },
];

async function mixedHome(viewport = DESKTOP): Promise<Page> {
  const page = await journeys.open("/");
  await page.setViewportSize(viewport);
  await routeMixed(page);
  await page.reload();
  await expect(connections(page).locator(".conn-rows").first().locator("> .conn-row")).toHaveCount(3);
  await expect(page.locator("#inbox [data-inbox-row]").first()).toBeVisible();
  return page;
}

/**
 * The area alone, in both themes, in a window tall enough to hold it, so a long open area is not stitched under the
 * sticky masthead; the pointer rests off the rows so no hover fill shows.
 */
async function captureArea(page: Page, prefix: string, name: string) {
  const size = page.viewportSize()!;
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: size.width, height: 2400 });
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.waitForTimeout(200);
    await connections(page).screenshot({ path: `test-results/screens/${prefix}${scheme}-home-connections-${name}.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize(size);
}

/** Open every row and the "N more" disclosure, as an owner reading every diagnostic would. */
async function expandAll(page: Page) {
  await moreSummary(page).click();
  for (const t of await connections(page).locator("button.conn-row-line").all()) if ((await t.getAttribute("aria-expanded")) !== "true") await t.click();
  await expect(connections(page).locator(".conn-row-detail:visible")).toHaveCount(4);
}

test("collapsed: each problem keeps its source, word and impact on one line, and Reconnect stays on the sign-in line", async () => {
  const page = await mixedHome();
  for (const { subject, state, line } of SHOWN) {
    const r = row(page, subject);
    await expect(r).toHaveAttribute("data-state", state);
    await expect(toggle(r)).toHaveText(line);
    await expect(toggle(r)).toHaveAttribute("aria-expanded", "false");
    await expect(r.locator(".conn-row-detail")).toBeHidden();
    // The icon is drawn in the state word's colour, so colour never stands alone.
    const [icon, word] = await Promise.all([r.locator(".conn-row-icon").evaluate((e) => getComputedStyle(e).color), r.locator(".conn-word").evaluate((e) => getComputedStyle(e).color)]);
    expect(icon, `${subject}: icon and word share the state colour`).toBe(word);
    // Compact: one text line beside its one button at desktop width.
    const height = await r.evaluate((e) => e.getBoundingClientRect().height);
    expect(height, `${subject} row height`).toBeLessThanOrEqual(46);
  }
  // Reconnect is on the closed sign-in line, in view, and leads to GitHub's repair controls.
  const reconnect = row(page, "GitHub").getByRole("button", { name: "Reconnect" });
  await expect(reconnect).toBeVisible();
  await expect(reconnect).toBeInViewport();
  await expect(row(page, "Gmail").getByRole("button", { name: "Retry now" })).toBeVisible();
  await expect(row(page, "Slack").getByRole("link", { name: "Open in Connections" })).toBeVisible();
  // The fourth source is named, with its state, on the closed "N more" line.
  await expect(moreSummary(page)).toHaveText("1 more: Jira (not read yet)");
  await expect(moreSummary(page)).toBeInViewport();
  await reconnect.click();
  await expect(page).toHaveURL(/\/connections\?open=github$/);
});

test("each row opens its diagnostics, last read and retry in place, and the keyboard keeps its place", async () => {
  const page = await mixedHome();
  const gmail = toggle(row(page, "Gmail"));
  await gmail.focus();
  const before = await gmail.evaluate((e) => ({ top: e.getBoundingClientRect().top, scroll: document.querySelector(".page")!.scrollTop }));
  await page.keyboard.press("Enter");
  await expect(gmail).toHaveAttribute("aria-expanded", "true");
  const detail = row(page, "Gmail").locator(".conn-row-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Gmail is not answering, so Gmail replies may be missing below.");
  await expect(detail.locator(".conn-failure")).toHaveText("GET /gmail/v1/users/me/messages → HTTP 500: backend error");
  await expect(detail).toContainText(/Last read (just now|\d+ \w+ ago)\./);
  await expect(detail).toContainText(/The next automatic read is at about \d\d:\d\d\./);
  await expect(gmail).toBeFocused();
  const after = await gmail.evaluate((e) => ({ top: e.getBoundingClientRect().top, scroll: document.querySelector(".page")!.scrollTop }));
  expect(after, "the open row does not move the toggle or the page").toEqual(before);
  // Space closes it again, still in place; Tab then reaches the row's own button.
  await page.keyboard.press("Space");
  await expect(gmail).toHaveAttribute("aria-expanded", "false");
  await expect(detail).toBeHidden();
  await expect(gmail).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(row(page, "Gmail").getByRole("button", { name: "Retry now" })).toBeFocused();

  // The partly read row: which part was not read, and when Slack was last read.
  const slack = toggle(row(page, "Slack"));
  await slack.focus();
  await page.keyboard.press("Enter");
  const partial = row(page, "Slack").locator(".conn-row-detail");
  await expect(partial).toContainText("Slack was only partly read, so Slack replies and mentions may be missing below.");
  await expect(partial.locator(".conn-failure")).toHaveText("Mentions were read; direct messages were not");
  await expect(partial).toContainText(/Last read (just now|\d+ \w+ ago)\./);
  await expect(slack).toBeFocused();
  await page.keyboard.press("Space");
  await expect(partial).toBeHidden();
  await expect(slack).toBeFocused();

  // The sign-in row: what the service said, and when GitHub was last read. A sign-in is never retried by itself.
  const github = toggle(row(page, "GitHub"));
  await github.focus();
  await page.keyboard.press("Enter");
  const signIn = row(page, "GitHub").locator(".conn-row-detail");
  await expect(signIn).toContainText("GitHub signed you out, so GitHub reviews, pull requests and assigned issues may be missing below.");
  await expect(signIn.locator(".conn-failure")).toHaveText("Bad credentials");
  await expect(signIn).toContainText(/Last read (just now|\d+ \w+ ago)\./);
  await expect(signIn).not.toContainText("next automatic read");
  await page.keyboard.press("Enter");

  // The source behind "1 more": the disclosure opens from the keyboard and its row opens in place too.
  await moreSummary(page).focus();
  await page.keyboard.press("Enter");
  const jira = toggle(row(page, "Jira"));
  await expect(jira).toBeVisible();
  await expect(moreSummary(page)).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(jira).toBeFocused();
  await page.keyboard.press("Enter");
  const unread = row(page, "Jira").locator(".conn-row-detail");
  await expect(unread).toContainText("No Source refresh has finished for Jira yet, so Jira work items may be missing below.");
  await expect(unread).toContainText("Never read.");
  await expect(unread).toContainText(/The next automatic read is at about \d\d:\d\d\./);
  await expect(jira).toBeFocused();
});

for (const [name, viewport] of [
  ["1280 x 800", DESKTOP],
  ["375 x 812", PHONE],
] as const) {
  test(`at ${name} the collapsed area keeps the Inbox higher than the open one and names every affected source`, async () => {
    const page = await mixedHome(viewport);
    const narrow = viewport === PHONE;
    // Closed: every affected source is named in what is drawn, the hidden one on the "N more" line.
    const text = await connections(page).evaluate((e) => (e as HTMLElement).innerText);
    for (const subject of ["GitHub", "Gmail", "Slack", "Jira"]) expect(text, `${subject} named while closed`).toContain(subject);
    const collapsed = await inboxHeadingTop(page);
    const prefix = narrow ? "narrow-" : "";
    // The window as the owner sees it with the area in view: on a phone it sits below For you now.
    if (narrow) await connections(page).evaluate((e) => e.scrollIntoView({ block: "start" }));
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(200);
      await page.screenshot({ path: `test-results/screens/${prefix}${scheme}-home-connections-mixed.png` });
    }
    await page.emulateMedia({ colorScheme: "light" });
    await captureArea(page, prefix, "mixed-area");
    await expandAll(page);
    const expanded = await inboxHeadingTop(page);
    expect(collapsed, "the Inbox heading sits higher while the area is closed").toBeLessThan(expanded);
    await captureArea(page, prefix, "mixed-open");
    test.info().annotations.push({ type: "inbox heading top", description: `${name}: ${Math.round(collapsed)} px closed, ${Math.round(expanded)} px open` });
  });
}

test("the fold: overlapping meetings, a briefing follower and one closed sign-in still leave a whole typed Inbox row at 1280 x 800", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize(DESKTOP);
  await routeSignIn(page);
  await page.reload();
  const forYou = page.getByRole("region", { name: "For you now" });
  await expect(forYou.locator('[data-heads-up="meeting-prep"]')).toHaveCount(2);
  await expect(forYou.locator('[data-heads-up="requested-briefing"]')).toBeVisible();
  const signIn = row(page, "GitHub");
  await expect(connections(page).locator(".conn-row")).toHaveCount(1);
  await expect(toggle(signIn)).toHaveAttribute("aria-expanded", "false");
  await expect(signIn.getByRole("button", { name: "Reconnect" })).toBeInViewport();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await completeRows(page), `${scheme}: complete Inbox rows`).toBeGreaterThanOrEqual(1);
    // The first row is typed (stamp and word) and its bottom edge is inside the window.
    const first = page.locator("#inbox [data-inbox-row]").first();
    await expect(first.locator(".inbox-kind-word")).not.toBeEmpty();
    const bottom = await first.evaluate((e) => e.getBoundingClientRect().bottom);
    expect(bottom, `${scheme}: first typed Inbox row's bottom edge`).toBeLessThanOrEqual(DESKTOP.height);
    test.info().annotations.push({ type: "first Inbox row bottom", description: `${scheme}: ${Math.round(bottom)} px of ${DESKTOP.height}` });
    await page.screenshot({ path: `test-results/screens/${scheme}-home-fold-overlap-sign-in.png` });
  }
  await page.emulateMedia({ colorScheme: "light" });
});

test("one healthy line stays one line once the problems are gone", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize(DESKTOP);
  const area = connections(page);
  await expect(area).toHaveAttribute("data-connections", "all_good");
  await expect(area).toContainText("All good");
  await expect(area.locator(".conn-row")).toHaveCount(0);
  expect(await area.evaluate((e) => e.getBoundingClientRect().height), "healthy area height").toBeLessThan(64);
});
