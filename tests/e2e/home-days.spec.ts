/**
 * Home's four days (#35 of spec #14): the same quiet, morning, overlap and heavy mixed-day data captured in both
 * themes at 1280 x 800 and 375 x 812, with the fold measured on each by the rows' bottom edges. Driven through the
 * Dashboard against the real bundled service and the TEST-ONLY fixtures, in a browser zone where it is morning; the
 * heavy day is the service's own answers with the design's heavy-day-v1 rows (`dense-fixture.json`) in place of the
 * open Inbox. It runs on its own.
 */
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AttentionItemView, ConnectionStatus, DecisionTotals } from "@attache/contracts";
import { api, JourneyBrowser, settled } from "./browser.ts";
import { completeForYouNow, completeRows, expectFoldMargin, routeSignIn } from "./home-fold.ts";
import { typeChoices } from "./inbox.ts";
import { MINUTE, SELF, setCalendar } from "./meetings.ts";
import { buildAll, ROOT, startStack, type Stack } from "./stack.ts";

let stack: Stack;
let journeys: JourneyBrowser;

/** A fixed-offset zone where the hour is 09 now, so the daily briefing written now is this morning's. */
function morningZone(): string {
  const offset = ((9 - new Date().getUTCHours() + 36) % 24) - 12;
  return offset === 0 ? "Etc/GMT" : offset > 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}

const DESKTOP = { width: 1280, height: 800 };
const TABLET = { width: 800, height: 1024 };
const PHONE = { width: 375, height: 812 };
const SCHEMES = ["light", "dark"] as const;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  buildAll();
  stack = await startStack();
  journeys = await JourneyBrowser.start(browser, stack.url, { timezoneId: morningZone(), viewport: DESKTOP });
  const page = await journeys.newPage();
  await page.goto(stack.pairUrl());
  await expect(page.getByRole("heading", { name: "Where should Attache keep your knowledge?" })).toBeVisible();
  await api(page, "POST", "/setup/data-folder", { path: stack.dataDir });
  await api(page, "POST", "/setup/identity", { name: "Test User", email: SELF, confirm: true });
  await api(page, "POST", "/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${stack.fixtureUrl}/model`, model: "fixture-model" } });
  await api(page, "POST", "/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678" } });
  await api(page, "POST", "/connections/gmail/configure", { method: "claude-ai", fields: {} });
  await api(page, "POST", "/connections/gcal/configure", { method: "claude-ai", fields: {} });
  await api(page, "POST", "/connections/claude-code/configure", { method: "hooks", fields: {} });
  await api(page, "POST", "/setup/complete");
  await api(page, "POST", "/import", { path: stack.vaultDir });
  await api(page, "POST", "/connections/github/refresh");
  await api(page, "POST", "/connections/gmail/refresh");
  await expect.poll(async () => (await api<{ items: unknown[] }>(page, "GET", "/attention?state=open")).items.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(6);
  await page.close();
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

const forYouNow = (page: Page) => page.getByRole("region", { name: "For you now" });
const connections = (page: Page) => page.locator("[data-connection-banner]");

/** Home as it is now, in each theme at desktop, tablet and phone sizes, scrolled to the top with the pointer out of the way. */
async function captureDay(page: Page, day: string) {
  for (const [viewport, prefix] of [[DESKTOP, ""], [TABLET, "tablet-"], [PHONE, "narrow-"]] as const) {
    await page.setViewportSize(viewport);
    for (const scheme of SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.mouse.move(1, 1);
      await page.locator(".page").evaluate((el) => el.scrollTo(0, 0));
      await settled(page);
      await page.screenshot({ path: `test-results/screens/${prefix}${scheme}-home-day-${day}.png` });
    }
  }
  await page.setViewportSize(DESKTOP);
  await page.emulateMedia({ colorScheme: null });
}

/**
 * The fold at 1280 x 800 in both themes: at least `rows` complete Inbox rows under the Inbox heading and, with
 * `margin`, the second Inbox row (and For you now's second entry, when `forYouNow`) ending FOLD_MARGIN px above it.
 */
async function expectFold(page: Page, rows: number, what: string, margin: { forYouNow: boolean } | null = null) {
  await page.setViewportSize(DESKTOP);
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.mouse.move(1, 1);
    expect(await completeRows(page), `${what}, ${scheme}`).toBeGreaterThanOrEqual(rows);
    if (margin) await expectFoldMargin(page, `${what}, ${scheme}`, margin.forYouNow);
  }
  await page.emulateMedia({ colorScheme: null });
}

test("arrangement: desktop thirds, tablet halves, and phone reading order", async () => {
  const page = await journeys.open("/");
  await expect(page.getByRole("region", { name: "The Daily Briefing" })).toBeVisible();
  for (const [viewport, arrangement] of [[DESKTOP, "desktop"], [TABLET, "tablet"], [PHONE, "phone"]] as const) {
    await page.setViewportSize(viewport);
    // Home puts its areas in the window's order on the render after a resize.
    await expect.poll(() => page.locator(".home-areas > *").first().getAttribute("class")).toContain(arrangement === "phone" ? "for-you-now" : "your-day");
    const boxes = await page.evaluate(() => Object.fromEntries(["daily", "for-you", "day", "inbox"].map((name) => {
      const selector = name === "daily" ? ".daily-briefing-area" : name === "for-you" ? ".for-you-now" : name === "day" ? ".your-day" : "#inbox";
      const box = document.querySelector(selector)!.getBoundingClientRect();
      return [name, { top: box.top, left: box.left, width: box.width, bottom: box.bottom }];
    })));
    // A keyboard and a screen reader meet the areas in the order they are drawn: top to bottom, then left to right.
    const documentOrder = await page.evaluate(() => [...document.querySelectorAll(".your-day, .for-you-now, #inbox")].map((el) => (el.classList.contains("your-day") ? "day" : el.id === "inbox" ? "inbox" : "for-you")));
    const drawnOrder = (["for-you", "day", "inbox"] as const).toSorted((a, b) => boxes[a]!.top - boxes[b]!.top || boxes[a]!.left - boxes[b]!.left);
    expect(documentOrder, `${arrangement}: document order`).toEqual(drawnOrder);
    if (arrangement === "phone") {
      expect(boxes["daily"]!.bottom).toBeLessThanOrEqual(boxes["for-you"]!.top + 1);
      expect(boxes["for-you"]!.bottom).toBeLessThanOrEqual(boxes["day"]!.top + 1);
      expect(boxes["day"]!.bottom).toBeLessThanOrEqual(boxes["inbox"]!.top + 1);
      for (const box of Object.values(boxes)) expect(box.width).toBeCloseTo(boxes["daily"]!.width, 0);
    } else {
      expect(boxes["for-you"]!.top).toBeCloseTo(boxes["inbox"]!.top, 0);
      expect(boxes["for-you"]!.width / boxes["inbox"]!.width).toBeCloseTo(arrangement === "desktop" ? 0.5 : 1, 1);
      expect(boxes["for-you"]!.left).toBeLessThan(boxes["inbox"]!.left);
    }
  }
});

test("quiet: nothing timely, every source read; For you now is one line and two rows show with room to spare under Your day and The Daily Briefing", async () => {
  const page = await journeys.open("/");
  await expect(forYouNow(page)).toHaveAttribute("data-for-you-now", "quiet");
  await expect(connections(page)).toHaveCount(0);
  await expectFold(page, 2, "complete Inbox rows on a quiet day with Your day and The Daily Briefing", { forYouNow: false });
  await captureDay(page, "quiet");
});

test("morning: an unread daily briefing leads; two For you now entries and two Inbox rows show with room to spare at 1280 x 800", async () => {
  const page = await journeys.open("/");
  const before = (await api<{ briefing: { id: string } | null }>(page, "GET", "/briefings/latest")).briefing?.id ?? null;
  await api(page, "POST", "/briefings", { kind: "daily" });
  await expect.poll(async () => (await api<{ briefing: { id: string } | null }>(page, "GET", "/briefings/latest")).briefing?.id ?? null, { timeout: 30_000 }).not.toBe(before);
  const lead = page.getByRole("region", { name: "The Daily Briefing" }).locator(".daily-briefing-card");
  await expect(lead).toBeVisible();
  await expect(forYouNow(page).locator("[data-inbox-row]")).not.toHaveCount(0, { timeout: 20_000 });
  await expect(connections(page)).toHaveCount(0);
  await expect(page.locator("#inbox h2").first()).toBeVisible();
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await completeForYouNow(page), `For you now complete entries, ${scheme}`).toBeGreaterThanOrEqual(2);
    expect(await completeRows(page), `Inbox complete rows, ${scheme}`).toBeGreaterThanOrEqual(2);
    await expectFoldMargin(page, `morning, ${scheme}`, true);
  }
  await captureDay(page, "morning");
  await lead.getByRole("button", { name: "Got it" }).click();
  await expect(page.getByRole("region", { name: "The Daily Briefing" }).locator(".briefing-folded")).toBeVisible();
  await expectFold(page, 0, "Inbox fold after Got it with Your day");
  await captureDay(page, "morning-got-it");
});

test("overlap: a meeting in progress, the next one, the briefing as a follower and one sign-in; Your day stays visible at 1280 x 800", async () => {
  const page = await journeys.open("/");
  await setCalendar(page, stack, [
    { id: "handover", summary: "Pilot handover", start: -10, end: 20, meetLink: "https://meet.google.com/abc-defg-hij", attendees: ["Nora Lind"] },
    { id: "triage", summary: "Billing triage", start: 10, end: 40, meetLink: "https://meet.google.com/bil-ling-tri", attendees: ["Sam Berg"] },
  ]);
  await routeSignIn(page);
  await page.reload();
  await expect(forYouNow(page).locator('[data-item-key^="gcal:"]')).toHaveCount(2);
  await expect(page.getByRole("region", { name: "The Daily Briefing" }).locator(".briefing-folded")).toBeVisible();
  await expect(connections(page)).toHaveAttribute("data-state", "sign_in");
  const day = page.getByRole("region", { name: "Your day" });
  await expect(day).toContainText("Pilot handover");
  await expect(day.locator('.your-day-wide [data-phase="in-progress"]')).toContainText("Join");
  await expect(day.locator('.your-day-wide [data-phase="upcoming"]')).toContainText("Billing triage");
  await expect(connections(page)).toBeVisible();
  await captureDay(page, "overlap");
  await page.setViewportSize(PHONE);
  await expect(day.locator(".your-day-narrow li")).toHaveCount(2);
  await page.route("**/api/v1/agenda?*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, coverage: { state: "offline", scopes: [], items: 0, at: new Date().toISOString() } } });
  });
  await page.reload();
  await expect(page.getByRole("region", { name: "Your day" })).toContainText("Could not read");
  await expect(page.getByRole("region", { name: "Your day" })).toContainText("Pilot handover");
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

/** heavy-day-v1: the design's dense fixture (docs/design/dashboard-redesign/astra/dense-fixture.json). */
interface DenseRow {
  id: string;
  group: string;
  title: string;
  source: string;
  path: string;
  actionId: string | null;
}
const DENSE = JSON.parse(readFileSync(join(ROOT, "docs/design/dashboard-redesign/astra/dense-fixture.json"), "utf8")) as {
  rows: DenseRow[];
  drafts: Array<{ id: string; status: string; attentionId: string | null }>;
};

/** Each heavy-day group as the Inbox type it stands for, and the source that raises it. */
const KIND_OF: Record<string, { kind: string; sourceKind: string }> = {
  Deadlines: { kind: "deadline", sourceKind: "vault" },
  "Review queue": { kind: "review_request", sourceKind: "github" },
  Meetings: { kind: "meeting_prep", sourceKind: "gcal" },
  "Pending replies": { kind: "pending_reply", sourceKind: "gmail" },
  "Facts to check": { kind: "fact-review", sourceKind: "vault-data" },
};

/** The heavy day's 30 open Inbox items, shaped like the service's own answer (`template`), dated around `now`. */
function heavyDay(template: AttentionItemView, now: number): AttentionItemView[] {
  const drafts = new Map(DENSE.drafts.map((d) => [d.id, d.status]));
  const rows = DENSE.rows.filter((r) => KIND_OF[r.group]);
  return rows.map((r, i) => {
    const { kind, sourceKind } = KIND_OF[r.group]!;
    const [relPath, lines] = r.path.split(":");
    const [from, to] = (lines ?? "1-1").split("-").map(Number);
    // Meetings later today, outside the 15 minutes before a start, so they stay in the Inbox.
    const start = now + (180 + 30 * i) * MINUTE;
    return {
      ...template,
      id: `heavy-${r.id}`,
      key: `heavy:${r.id}`,
      kind,
      sourceKind,
      title: r.title,
      summary: r.title,
      why: `From ${r.source}, ${r.path}`,
      url: sourceKind === "github" ? `https://github.com/acme/orion/pull/${100 + i}` : null,
      dueAt: kind === "deadline" ? new Date(now + (i % 3) * 86_400_000).toISOString() : null,
      priority: 100 - i,
      state: "open",
      snoozeUntil: null,
      evidence: [{ label: r.path, relPath, lines: [from!, to!], observedAt: new Date(now).toISOString() }],
      firstSeenAt: new Date(now - i * 7 * MINUTE).toISOString(),
      updatedAt: new Date(now - i * 7 * MINUTE).toISOString(),
      actionId: r.actionId,
      actionStatus: r.actionId ? ((drafts.get(r.actionId) ?? null) as AttentionItemView["actionStatus"]) : null,
      changedSinceDecision: false,
      draftable: null,
      meeting: kind === "meeting_prep" ? { start: new Date(start).toISOString(), end: new Date(start + 30 * MINUTE).toISOString(), meetLink: null, attendees: ["Priya Shah"] } : null,
    };
  });
}

/** heavy-day-v1's 38 decisions: 28 Inbox items (two have their Draft waiting), four Drafts and six Proposals. */
const HEAVY_TOTALS: DecisionTotals = { inbox: 28, drafts: 4, proposals: 6, signIns: 0 };

test("Your day states: checking, complete empty, nothing more, no calendar and switched off", async () => {
  const page = await journeys.open("/");
  const day = page.getByRole("region", { name: "Your day" });
  const response = { connection: { id: "gcal", status: "connected" }, events: [], readAt: new Date().toISOString(), coverage: { state: "complete", scopes: [], items: 0, at: new Date().toISOString() } };
  await page.route("**/api/v1/agenda?*", async (route) => route.fulfill({ json: response }));
  await page.reload();
  await expect(day).toContainText("Nothing on your calendar today");
  await captureDay(page, "empty-agenda");

  const now = Date.now();
  await page.unroute("**/api/v1/agenda?*");
  await page.route("**/api/v1/agenda?*", async (route) => route.fulfill({ json: { ...response, events: [
    { id: "finished", start: new Date(now - 60_000).toISOString(), end: new Date(now - 1).toISOString(), allDay: false, title: "Finished meeting", response: "accepted", calendarUrl: "https://calendar.google.com/finished", meetLink: null },
    { id: "tomorrow", start: new Date(now + 86_400_000).toISOString(), end: new Date(now + 86_401_000).toISOString(), allDay: false, title: "Tomorrow meeting", response: "accepted", calendarUrl: "https://calendar.google.com/tomorrow", meetLink: null },
  ] } }));
  await page.reload();
  await expect(day).toContainText("Nothing more today");
  await expect(day).toContainText("Tomorrow meeting");
  await captureDay(page, "finished-agenda");

  await page.unroute("**/api/v1/agenda?*");
  await page.route("**/api/v1/agenda?*", async (route) => route.fulfill({ json: { ...response, connection: null, readAt: null, coverage: null } }));
  await page.reload();
  await expect(day).toContainText("No calendar connected");

  await page.unroute("**/api/v1/agenda?*");
  await page.route("**/api/v1/agenda?*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill({ json: response });
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(day).toContainText("Checking");
  await expect(day).toContainText("Nothing on your calendar today");

  await page.unrouteAll({ behavior: "ignoreErrors" });
  await api(page, "PUT", "/features", { changes: { attention: false }, cascade: true });
  await page.reload();
  await expect(day).toContainText("Switched off");
  await api(page, "PUT", "/features", { changes: { attention: true }, cascade: true });
});

test("heavy mixed day: thirty typed rows, 38 decisions and a source that failed for now; the first rows still show at 1280 x 800", async () => {
  const page = await journeys.open("/");
  const now = Date.now();
  await page.route(
    (url) => url.pathname === "/api/v1/attention" && url.searchParams.get("state") === "open",
    async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { items: AttentionItemView[] };
      await route.fulfill({ response: res, json: { ...body, items: heavyDay(body.items[0]!, now) } });
    },
  );
  await page.route("**/api/v1/decision-count", (route) => route.fulfill({ json: HEAVY_TOTALS }));
  // Slack's last refresh failed for now; it was read yesterday at 17:12. Nothing needs a sign-in.
  await page.route("**/api/v1/capabilities", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { connections: ConnectionStatus[] };
    const gh = body.connections.find((c) => c.kind === "github")!;
    const yesterday = new Date(now - 86_400_000);
    yesterday.setHours(17, 12, 0, 0);
    const slack: ConnectionStatus = { ...gh, id: "slack", kind: "slack", label: "Slack", lastReadAt: yesterday.toISOString(), coverage: gh.coverage && { ...gh.coverage, state: "offline", note: "Slack did not answer in time" } };
    body.connections = [...body.connections.filter((c) => c.kind !== "slack"), slack];
    await route.fulfill({ response: res, json: body });
  });
  await page.reload();
  await expect(page).toHaveTitle("(38) Attache");
  await expect(page.locator("#inbox [data-need-you]")).toHaveText("28 need you here");
  await expect(page.locator("#inbox [data-range]")).toHaveText("1–20 of 30");
  await expect(connections(page)).toContainText("Slack");
  // The first page shows rows of several types with their words.
  await expect(page.locator("#inbox .inbox-kind-word", { hasText: "Deadline" }).first()).toBeVisible();
  await expect(page.locator("#inbox .inbox-kind-word", { hasText: "Review request" }).first()).toBeVisible();
  await expect(page.locator("#inbox [data-inbox-row]").first()).toBeVisible();
  await expectFold(page, 2, "the heavy day's complete Inbox rows", { forYouNow: true });
  // An entry whose reason is "Due today" says it once, not again as its time.
  const dueToday = forYouNow(page).locator("[data-inbox-row]").first();
  await expect(dueToday.locator(".inbox-source")).toContainText("Due today");
  expect((await dueToday.innerText()).match(/Due today/g)).toHaveLength(1);
  await captureDay(page, "heavy");
  // Every heavy-day type is in "All types" with its count (after the captures, which the menu's focus would mark).
  expect(await typeChoices(page)).toEqual(expect.arrayContaining(["Deadline 8", "Review request 8", "Meeting prep 4", "Pending reply 6", "Fact to check 4"]));
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

/** Where the first element a selector finds is drawn. */
async function boxOf(page: Page, selector: string) {
  const box = await page.locator(selector).first().boundingBox();
  expect(box, selector).not.toBeNull();
  return { ...box!, right: box!.x + box!.width, bottom: box!.y + box!.height, middle: box!.y + box!.height / 2 };
}

test("the masthead, the Home heading, Search the Brain and the Inbox heading follow the mockups", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize(DESKTOP);
  await expect(page.locator("#inbox [data-inbox-row]").first()).toBeVisible();

  // The masthead: the total raised beside the wordmark, the current screen a solid pill, Approvals' count in an
  // outlined box, Connections' green dot, and this Machine's name at the far right of the column.
  // The total is the tab title's number.
  const total = (await page.title()).match(/^\((\d+\+?)\)/)![1]!;
  await expect(page.locator(".masthead .brand .brand-total")).toHaveText(total);
  const [word, number] = [await boxOf(page, ".masthead .brand-name"), await boxOf(page, ".masthead .brand-total")];
  expect(number.x, "the total follows the wordmark").toBeGreaterThanOrEqual(word.right);
  expect(number.middle, "the total is raised").toBeLessThan(word.middle - 2);
  const current = page.locator('.masthead-nav a[aria-current="page"]');
  await expect(current).toHaveText("Home");
  expect(await current.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
  const approvals = page.locator('.masthead-nav a[href="/approvals"] .count');
  if (await approvals.count()) expect(await approvals.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe("solid");
  await expect(page.locator('.masthead-nav a[href="/connections"] .connection-healthy-dot')).toBeVisible();
  // The column's right edge is the search field's.
  const [machine, column] = [await boxOf(page, ".machine-trigger"), await boxOf(page, ".home-search .search-box")];
  expect(Math.abs(machine.right - column.right), "this Machine ends the column").toBeLessThanOrEqual(1);
  await expect(page.locator(".machine-trigger-name")).not.toHaveText("");

  // "Home" and the full date on one line, the date after the heading; no trail.
  const [title, date] = [await boxOf(page, ".home-head h1"), await boxOf(page, ".home-head time")];
  expect(date.x).toBeGreaterThan(title.right);
  expect(date.y).toBeLessThan(title.bottom);
  expect(date.bottom).toBeGreaterThan(title.y);
  await expect(page.locator(".home-head")).not.toContainText("/");
  await expect(page.locator(".home-head time")).toHaveText(/^[A-Z][a-z]+day, \d{1,2} [A-Z][a-z]+$/);

  // Search the Brain: one tall field holding the search icon, the Ctrl K keycap and, after a divider, Browse.
  const field = await boxOf(page, ".home-search .search-box");
  expect(field.height).toBeGreaterThanOrEqual(48);
  const [icon, key, browse] = [await boxOf(page, ".home-search .search-box > .icon"), await boxOf(page, ".home-search .search-key"), await boxOf(page, ".home-search .browse-toggle")];
  for (const [name, part] of [["icon", icon], ["keycap", key], ["Browse", browse]] as const) {
    expect(part.x, `${name} inside the field`).toBeGreaterThanOrEqual(field.x);
    expect(part.right, `${name} inside the field`).toBeLessThanOrEqual(field.right);
    expect(part.y, `${name} inside the field`).toBeGreaterThanOrEqual(field.y);
    expect(part.bottom, `${name} inside the field`).toBeLessThanOrEqual(field.bottom);
  }
  expect(key.right, "the keycap before Browse").toBeLessThan(browse.x);
  expect(await page.locator(".home-search .browse-toggle").evaluate((el) => parseFloat(getComputedStyle(el).borderLeftWidth)), "a divider before Browse").toBeGreaterThanOrEqual(1);

  // The Inbox heading: "N need you here" beside the word Inbox, the reconciliation line under it, two menus at the right.
  const [inbox, needYou, types, view] = [await boxOf(page, "#inbox h2"), await boxOf(page, "#inbox [data-need-you]"), await boxOf(page, "#inbox .choice-menu-trigger >> nth=0"), await boxOf(page, "#inbox .choice-menu-trigger >> nth=1")];
  expect(needYou.x).toBeGreaterThan(inbox.right);
  expect(Math.abs(needYou.middle - inbox.middle)).toBeLessThanOrEqual(8);
  await expect(page.locator("#inbox").getByRole("button", { name: "Type: All types" })).toBeVisible();
  await expect(page.locator("#inbox").getByRole("button", { name: "View options", exact: true })).toBeVisible();
  for (const menu of [types, view]) expect(menu.y, "the menus on the heading's line").toBeLessThan(inbox.bottom);
  expect(view.x).toBeGreaterThan(types.right);
  const list = await boxOf(page, "#inbox .inbox-rows");
  expect(Math.abs(view.right - list.right), "the menus end at the list's right edge").toBeLessThanOrEqual(1);
  if (await page.locator("#inbox .count-line").count()) expect((await boxOf(page, "#inbox .count-line")).y).toBeGreaterThanOrEqual(inbox.bottom - 4);
  await page.locator("#inbox").getByRole("button", { name: "View options", exact: true }).click();
  const views = page.locator("#inbox").getByRole("group", { name: "View options" }).getByRole("button");
  await expect(views).toHaveText(["Priority order", "Newest first", "Group by type", "Hidden"]);
  await expect(views.filter({ hasText: "Priority order" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");

  // A row in the Inbox's two thirds: one line with Start working and Snooze and Done as icons with their full names.
  const row = page.locator("#inbox [data-inbox-row]").first();
  const subject = (await row.locator("[data-row-toggle]").textContent())!;
  const line = await row.locator(".inbox-line").boundingBox();
  const start = await row.getByRole("button", { name: `Start working: ${subject}` }).boundingBox();
  const subjectBox = await row.locator("[data-row-toggle]").boundingBox();
  expect(start!.x, "the actions on the subject's line, at its right").toBeGreaterThan(subjectBox!.x + subjectBox!.width);
  expect(start!.y).toBeLessThan(subjectBox!.y + subjectBox!.height);
  for (const name of ["Snooze", "Done"]) {
    const button = row.getByRole("button", { name: `${name}: ${subject}` });
    await expect(button).toBeVisible();
    await expect(button, `${name} is an icon`).toHaveText("", { useInnerText: true });
    expect((await button.boundingBox())!.width).toBeLessThanOrEqual(40);
  }
  await expect(row.getByRole("button", { name: `Done: ${subject}` })).not.toHaveClass(/primary/);
  expect(line!.height, "a row is one line of subject and source").toBeLessThanOrEqual(70);

  // A half: the three behind one Actions button.
  await page.setViewportSize(TABLET);
  await expect(row.getByRole("button", { name: `Actions: ${subject}` })).toBeVisible();
  await expect(row.getByRole("button", { name: `Snooze: ${subject}` })).toBeHidden();
  await page.setViewportSize(DESKTOP);
});

test("no unresolved console errors across the days", () => {
  expect(journeys.consoleErrors).toEqual([]);
});
