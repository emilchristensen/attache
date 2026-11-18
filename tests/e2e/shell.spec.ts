/**
 * The frame around every screen (#18 of spec #14): the desktop masthead, this
 * Machine's disclosure, the persistent silent-Reader warning, the narrow
 * bottom bar and its More sheet, the routes and the keyboard shortcuts,
 * driven through the Dashboard against the real bundled service and the
 * TEST-ONLY fixtures.
 */
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
  // A finished setup with GitHub, so the Inbox has items, and one waiting Proposal, so Approvals has a decision.
  const page = await journeys.newPage();
  await page.goto(stack.pairUrl());
  await expect(page.getByRole("heading", { name: "Where should Attache keep your knowledge?" })).toBeVisible();
  await api(page, "POST", "/setup/data-folder", { path: stack.dataDir });
  await api(page, "POST", "/setup/identity", { name: "Test User", email: "alex@example.com", confirm: true });
  await api(page, "POST", "/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${stack.fixtureUrl}/model`, model: "fixture-model" } });
  await api(page, "POST", "/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678" } });
  await api(page, "POST", "/setup/complete");
  await api(page, "POST", "/connections/github/refresh");
  await api(page, "POST", "/memory/proposals", { item: { action: "create", type: "person", title: "Lena Berg", facts: [{ subject: "Role", value: "Postmark account manager" }] }, reason: "Introduced in the vendor call" });
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

const SCREENS = ["Home", "Approvals", "Brain", "Connections", "Jobs", "Settings"];

/** The masthead's navigation, or the bottom bar on a narrow window: whichever shows. */
const mainNav = (page: Page) => page.getByRole("navigation", { name: "Main" });

/** Every link and button in `nav` sits on one line. */
async function oneLine(page: Page): Promise<boolean> {
  return page.locator(".masthead").evaluate((bar) => {
    const items = [...bar.querySelectorAll("a, button")].filter((el) => (el as HTMLElement).offsetParent !== null);
    const middles = items.map((el) => {
      const r = el.getBoundingClientRect();
      return Math.round(r.top + r.height / 2);
    });
    return Math.max(...middles) - Math.min(...middles) <= 2;
  });
}

test("masthead: one line names every screen above a centred reading column, and Home is selected without its badge", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 1280, height: 800 });
  const nav = mainNav(page);
  await expect(nav.getByRole("link")).toHaveText(SCREENS.map((s) => new RegExp(`^${s}`)));
  expect(await oneLine(page), "the masthead is one line").toBe(true);
  // Home is selected by shape and contrast, with no number while the owner is on Home.
  const home = nav.getByRole("link", { name: /^Home/ });
  await expect(home).toHaveAttribute("aria-current", "page");
  await expect(home.locator(".count")).toHaveCount(0);
  // The Proposal waits in Approvals, and the badge names its destination for a screen reader.
  await expect(nav.getByRole("link", { name: "Approvals, 1 waiting" })).toBeVisible();
  // The reading column is about 1072 px, centred beside the scrollbar, and starts where the masthead's mark does.
  const column = await page.locator(".page").first().evaluate((el) => {
    const box = el.firstElementChild!.getBoundingClientRect();
    return { left: box.left, right: el.clientWidth - box.right, width: box.width, brand: document.querySelector(".masthead .brand")!.getBoundingClientRect().left };
  });
  expect(column.width, "reading column width").toBeLessThanOrEqual(1072);
  expect(column.width, "reading column width").toBeGreaterThanOrEqual(1040);
  expect(Math.abs(column.left - column.right), "reading column is centred").toBeLessThanOrEqual(1);
  expect(column.left, "the column starts under the mark").toBeCloseTo(column.brand, 0);
  // On Home the search launcher is not needed; elsewhere it is, and Home shows its decision badge again.
  await expect(page.getByRole("button", { name: /^Search the Brain/ })).toHaveCount(0);
  await nav.getByRole("link", { name: /^Jobs/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Jobs" })).toBeVisible();
  await expect(home.locator(".count")).toHaveText(/^\d+$/, { timeout: 30_000 });
  await expect(nav.getByRole("link", { name: /^Home, \d+ needs? you$/ })).toBeVisible();
  await page.getByRole("button", { name: /^Search the Brain/ }).click();
  await expect(page).toHaveURL(`${stack.url}/brain`);
  await expect(page.getByRole("searchbox", { name: "Search the Brain" })).toBeFocused();
});

/** The number a link or heading shows, or 0 when it shows none. */
async function shownNumber(locator: ReturnType<Page["locator"]>): Promise<number> {
  if (!(await locator.count())) return 0;
  return Number((await locator.first().textContent())!.match(/\d+/)![0]);
}

test("count: Home's number beside its Inbox heading, Approvals and Connections add up to the tab title and the mark's name", async () => {
  const page = await journeys.open("/");
  await expect(page).toHaveTitle(/^\(\d+\) Attache$/, { timeout: 30_000 });
  await expect(page.locator("[data-need-you]")).toHaveText(/^\d+ needs? you here$/);
  const nav = mainNav(page);
  const home = await shownNumber(page.locator("[data-need-you]"));
  const approvals = await shownNumber(nav.getByRole("link", { name: /^Approvals/ }).locator(".count"));
  const connections = await shownNumber(nav.getByRole("link", { name: /^Connections/ }).locator(".count"));
  expect(approvals, "the waiting Proposal").toBe(1);
  const total = home + approvals + connections;
  await expect(page).toHaveTitle(`(${total}) Attache`);
  await expect(page.getByRole("link", { name: `Attache, ${total} need you` })).toBeVisible();
  await expect(page.locator(".masthead .brand .logo-dot")).toHaveCount(1);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", "/favicon.svg");
  // Off Home the same number is Home's badge.
  await nav.getByRole("link", { name: /^Jobs/ }).click();
  await expect(nav.getByRole("link", { name: /^Home/ }).locator(".count")).toHaveText(String(home));
});

test("count: while Drafts is still asked, Home keeps loading after the Inbox answers, and shows an Inbox failure with Retry at once", async () => {
  const page = await journeys.newPage();
  const drafts = "**/api/v1/actions?*";
  const inbox = "**/api/v1/attention?state=open*";
  try {
    // The Inbox answers first; Drafts is held. Home must not show an empty list.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(drafts, (route) => held.then(() => route.continue()).catch(() => undefined));
    const answered = Promise.all([page.waitForResponse((r) => r.url().includes("/api/v1/attention?state=open")), page.waitForResponse((r) => r.url().endsWith("/api/v1/connections"))]);
    await page.goto(`${stack.url}/`);
    await answered;
    await expect(page.getByRole("status", { name: "Loading the Inbox" })).toBeVisible();
    await expect(page.locator(".attention-group")).toHaveCount(0);
    release();
    await expect(page.locator(".attention-group").first()).toBeVisible();
    await page.unroute(drafts);

    // The Inbox fails while Drafts is held: the failure and its Retry show without waiting for Drafts.
    let releaseAgain!: () => void;
    const heldAgain = new Promise<void>((r) => (releaseAgain = r));
    await page.route(drafts, (route) => heldAgain.then(() => route.continue()).catch(() => undefined));
    await page.route(inbox, (route) => route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "busy" } } }));
    await page.reload();
    const failure = page.getByRole("alert").filter({ hasText: "busy" });
    await expect(failure).toBeVisible();
    await expect(failure.getByRole("button", { name: "Try again" })).toBeVisible();
    await page.unroute(inbox);
    releaseAgain();
    await page.unroute(drafts);
    await failure.getByRole("button", { name: "Try again" }).click();
    await expect(page.locator(".attention-group").first()).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.close();
  }
});

test("skip link: the first Tab offers Skip to content, which moves focus to the page", async () => {
  const page = await journeys.open("/jobs");
  await expect(page.getByRole("heading", { level: 1, name: "Jobs" })).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await expect(page).toHaveURL(`${stack.url}/jobs`);
});

test("routes: Home, Approvals and Brain live at their new addresses, and the old Memory and Drafts routes are gone", async () => {
  const page = await journeys.open("/brain");
  await expect(page.getByRole("heading", { level: 1, name: "Brain" })).toBeVisible();
  await expect(mainNav(page).getByRole("link", { name: /^Brain/ })).toHaveAttribute("aria-current", "page");
  await page.goto(`${stack.url}/approvals`);
  await expect(page.getByRole("heading", { level: 1, name: "Approvals" })).toBeVisible();
  await expect(mainNav(page).getByRole("link", { name: /^Approvals/ })).toHaveAttribute("aria-current", "page");
  // Waiting holds Drafts to send and Changes to the Brain; its tab carries the same number as the navigation.
  await expect(page.getByRole("tab", { name: "Waiting, 1 waiting" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("region", { name: "Drafts to send" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Changes to the Brain" }).locator('[data-approval-row="proposal"]')).toHaveCount(1);
  for (const old of ["/memory", "/drafts", "/memory?tab=person", "/drafts?id=x"]) {
    await page.goto(`${stack.url}${old}`);
    await expect(page.getByRole("heading", { level: 1, name: "Not found" })).toBeVisible();
    expect(new URL(page.url()).pathname, `${old} is not redirected`).toBe(old.split("?")[0]);
  }
});

test("shortcuts: g then a letter jumps to each screen outside text fields and dialogs, and ? lists them", async () => {
  const page = await journeys.open("/");
  const jumps: Array<[string, string, string]> = [
    ["a", "/approvals", "Approvals"],
    ["b", "/brain", "Brain"],
    ["j", "/jobs", "Jobs"],
    ["c", "/connections", "Connections"],
    ["s", "/settings", "Settings"],
    ["h", "/", "Home"],
  ];
  await expect(mainNav(page).getByRole("link", { name: /^Home/ })).toHaveAttribute("aria-current", "page");
  for (const [key, path, screen] of jumps) {
    await page.keyboard.press("g");
    await page.keyboard.press(key);
    await expect(page, `g then ${key}`).toHaveURL(`${stack.url}${path}`);
    await expect(mainNav(page).getByRole("link", { name: new RegExp(`^${screen}`) })).toHaveAttribute("aria-current", "page");
  }
  // Typing in a field types: g then j stays on the Brain.
  await page.goto(`${stack.url}/brain`);
  const search = page.getByRole("searchbox", { name: "Search the Brain" });
  await search.click();
  await page.keyboard.press("g");
  await page.keyboard.press("j");
  await expect(search).toHaveValue("gj");
  await expect(page).toHaveURL(`${stack.url}/brain`);
  await search.fill("");
  await search.blur();

  // ? opens the shortcut sheet, which lists every jump by its new name.
  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  for (const [key, , screen] of jumps) await expect(sheet.getByRole("row", { name: new RegExp(`g then ${key}.*${screen}`) })).toBeVisible();
  await expect(sheet.getByRole("row", { name: /\?.*shortcut/i })).toBeVisible();
  // Shortcuts do nothing while a dialog is open.
  await page.keyboard.press("g");
  await page.keyboard.press("j");
  await expect(page).toHaveURL(`${stack.url}/brain`);
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await page.keyboard.press("g");
  await page.keyboard.press("j");
  await expect(page).toHaveURL(`${stack.url}/jobs`);
});

/** The masthead's three parts do not overlap and stay inside its column: every control can be clicked. */
async function mastheadFits(page: Page): Promise<string[]> {
  return page.locator(".masthead-inner").evaluate((inner) => {
    const box = (sel: string) => inner.querySelector(sel)!.getBoundingClientRect();
    const [brand, nav, tools] = [box(".brand"), box(".masthead-nav"), box(".masthead-tools")];
    const links = [...inner.querySelectorAll(".masthead-nav a")].map((a) => a.getBoundingClientRect());
    // The column ends inside the padding and the scrollbar gutter the masthead reserves (`clientWidth` leaves it out).
    const edge = inner.getBoundingClientRect().left + inner.clientLeft + inner.clientWidth - parseFloat(getComputedStyle(inner).paddingRight);
    const problems: string[] = [];
    if (brand.right > nav.left) problems.push("mark overlaps the screens");
    if (Math.max(...links.map((l) => l.right)) > tools.left) problems.push("screens run under the tools");
    if (tools.right > edge + 1) problems.push("tools leave the column");
    return problems;
  });
}

/**
 * A narrow masthead holds the mark and, while the live connection is lost, this Machine's button: neither is cut short,
 * they do not overlap, and the button stays inside the column. Measured rather than assumed: the mark is set in the
 * system's Georgia, which is wider on macOS and Windows than Linux's stand-in.
 */
async function narrowMastheadFits(page: Page): Promise<string[]> {
  return page.locator(".masthead-inner").evaluate((inner) => {
    const brand = inner.querySelector<HTMLElement>(".brand")!;
    const button = inner.querySelector(".machine-trigger")!.getBoundingClientRect();
    const live = inner.querySelector<HTMLElement>(".machine-trigger-live")!;
    // The column ends inside the padding and the scrollbar gutter the masthead reserves (`clientWidth` leaves it out).
    const edge = inner.getBoundingClientRect().left + inner.clientLeft + inner.clientWidth - parseFloat(getComputedStyle(inner).paddingRight);
    const problems: string[] = [];
    if (button.right > edge + 1) problems.push(`the Machine button leaves the column (${button.right} > ${edge})`);
    if (brand.getBoundingClientRect().right > button.left) problems.push("the mark runs under the Machine button");
    if (brand.scrollWidth > brand.clientWidth) problems.push("the mark is cut short");
    if (live.scrollWidth > live.clientWidth) problems.push(`the state "${live.textContent}" is cut short`);
    return problems;
  });
}

test("this Machine: the masthead disclosure names this Machine and the Reader, and reports a lost live connection", async () => {
  const page = await journeys.open("/jobs");
  const machine = await api<{ name: string }>(page, "GET", "/machine");
  const trigger = page.getByRole("button", { name: /^This Machine/ });
  await expect(trigger).toContainText(machine.name);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  const panel = page.getByRole("region", { name: "This Machine" });
  await expect(panel).toContainText(machine.name);
  await expect(panel.locator(".reader-line")).toHaveAttribute("data-reader", "alone");
  await expect(panel).toContainText("This Machine runs Source refresh and briefings.");
  await expect(panel).toContainText("Live updates are connected.");
  await expect(panel.getByRole("link", { name: /Machines and Replication/ })).toHaveAttribute("href", "/settings");
  // Escape belongs to the topmost layer: the shortcut sheet over the disclosure closes first.
  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(panel).toBeVisible();
  // Escape closes it and gives focus back to the button.
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
  // Following its link by keyboard leaves focus on the button, not at the top of the page.
  await page.keyboard.press("Enter");
  await panel.getByRole("link", { name: /Machines and Replication/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${stack.url}/settings`);
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();

  // A lost live connection shows on the button itself, and the disclosure says what it means.
  await stack.stopService();
  await expect(trigger).toContainText(/Reconnecting|Disconnected/, { timeout: 20_000 });
  await trigger.click();
  await expect(panel).toContainText(/Reconnecting to the Attache service|Disconnected from the Attache service/);
  await page.keyboard.press("Escape");
  // On a phone the button shows the whole state without the Machine's name, beside the mark and inside the window. On
  // the narrowest phones (280 px) the briefcase alone is the mark, and the link is still named Attache, with the
  // decisions that wait.
  for (const width of [320, 280]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(trigger.locator(".machine-trigger-live")).toBeVisible();
    await expect(trigger.locator(".machine-trigger-name")).toBeHidden();
    expect(await narrowMastheadFits(page), `masthead at ${width}px, connection lost`).toEqual([]);
  }
  await expect(page.getByRole("link", { name: /^Attache, \d+ needs? you$/ })).toBeVisible();
  // Just above the bottom bar, and where the masthead is widest, nothing overlaps, also with a long name and the lost state.
  for (const width of [970, 1121]) {
    await page.setViewportSize({ width, height: 800 });
    expect(await mastheadFits(page), `masthead at ${width}px, connection lost`).toEqual([]);
  }
  await page.setViewportSize({ width: 1360, height: 900 });
  await trigger.click();
  await stack.startService();
  await expect(trigger).not.toContainText(/Reconnecting|Disconnected/, { timeout: 30_000 });
  await expect(panel).toContainText("Live updates are connected.");
  await page.keyboard.press("Escape");
  // A long name, with spaces or as one unbroken host name: the button cuts it short and still says all of it, and the
  // panel shows all of it inside its edges.
  for (const name of ["Emil's MacBook Pro 16-inch", "EmilsMacBookPro16inch2024WorkStation.local"]) {
    await api(page, "PATCH", "/machine", { name });
    await expect(trigger).toContainText(name);
    await expect(trigger).toHaveAccessibleName(`This Machine: ${name}`);
    for (const width of [970, 1121, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      expect(await mastheadFits(page), `masthead at ${width}px with the Machine name ${name}`).toEqual([]);
    }
    const shown = trigger.locator(".machine-trigger-name");
    expect(await shown.evaluate((el) => el.scrollWidth > el.clientWidth && getComputedStyle(el).textOverflow), `${name} ends in an ellipsis`).toBe("ellipsis");
    await page.setViewportSize({ width: 1360, height: 900 });
    await trigger.click();
    await expect(panel).toContainText(name);
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth), `the panel holds ${name}`).toBe(true);
    await page.keyboard.press("Escape");
  }
  await api(page, "PATCH", "/machine", { name: machine.name });
});

test("Reader: a silent Reader stays in view on every screen and size without opening anything, and Connections names the Reader at once", async () => {
  const page = await journeys.open("/connections");
  // The Reader line opens the Connections page, before any card.
  await expect(page.locator(".page .reader-line").first()).toContainText("This Machine runs Source refresh and briefings.");
  // The Reader view (`ReaderView` in packages/contracts) of a Work Mac that stopped renewing its lease two hours ago.
  const silent = { machine: { id: "7f9c2a54-3f7e-4f5b-9b47-6c2b9a1d0e11", name: "Work Mac" }, thisMachine: false, replicated: true, heartbeatAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), silent: true, lastRefreshAt: new Date(Date.now() - 3 * 3_600_000).toISOString() };
  await page.route("**/api/v1/reader", (route) => route.fulfill({ json: silent }));
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 360, height: 800 }]) {
      await page.setViewportSize(viewport);
      for (const path of ["/", "/jobs", "/brain"]) {
        await page.goto(`${stack.url}${path}`);
        const warning = page.locator("[data-reader-warning]");
        await expect(warning, `${path} at ${viewport.width}px`).toBeVisible();
        await expect(warning).toContainText("Work Mac");
        await expect(warning).toContainText(/silent/);
        await expect(warning).toBeInViewport();
      }
    }
  } finally {
    await page.unroute("**/api/v1/reader");
    await page.setViewportSize({ width: 1360, height: 900 });
  }
  await page.goto(`${stack.url}/jobs`);
  await expect(page.locator(".page").first()).toBeVisible();
  await expect(page.locator("[data-reader-warning]")).toHaveCount(0);

  // A long Machine name with no break in it wraps inside the banner on a phone.
  const unbroken = "W".repeat(64);
  await page.route("**/api/v1/reader", (route) => route.fulfill({ json: { ...silent, machine: { ...silent.machine, name: unbroken } } }));
  await page.setViewportSize({ width: 360, height: 800 });
  await page.reload();
  const banner = page.locator("[data-reader-warning]");
  await expect(banner).toContainText(unbroken);
  expect(await banner.evaluate((el) => el.scrollWidth <= el.clientWidth), "the banner's words stay inside it at 360 px").toBe(true);
  await expect(banner.getByRole("link", { name: "Machines and Replication" })).toBeInViewport();
  await page.unroute("**/api/v1/reader");
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.reload();
  await expect(banner).toHaveCount(0);

  // A Reader that goes quiet while the tab is open: its lease runs out with no event, and the warning still arrives.
  const tab = await journeys.newPage();
  await tab.clock.install();
  let answer: "renewed" | "failing" | "lapsed" = "renewed";
  const renewed = { ...silent, silent: false, heartbeatAt: new Date(Date.now() - 29 * 60_000).toISOString() };
  await tab.route("**/api/v1/reader", (route) => (answer === "failing" ? route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "busy" } } }) : route.fulfill({ json: answer === "lapsed" ? { ...renewed, silent: true } : renewed })));
  await tab.goto(`${stack.url}/jobs`);
  await expect(tab.getByRole("heading", { level: 1, name: "Jobs" })).toBeVisible();
  await expect(tab.locator("[data-reader-warning]")).toHaveCount(0);
  // The check at the lease's end fails; the Dashboard asks again until it gets an answer.
  answer = "failing";
  await tab.clock.runFor(2 * 60_000);
  await expect(tab.locator("[data-reader-warning]")).toHaveCount(0);
  answer = "lapsed";
  await tab.clock.runFor(60_000);
  await expect(tab.locator("[data-reader-warning]")).toContainText("Work Mac");
  // The Reader comes back, but the answer to the event that says so fails: the warning still goes, once an answer arrives.
  answer = "failing";
  const name = (await api<{ name: string }>(tab, "GET", "/machine")).name;
  const failed = tab.waitForResponse((r) => r.url().endsWith("/api/v1/reader") && r.status() === 503);
  await api(tab, "PATCH", "/machine", { name });
  await tab.clock.runFor(500);
  await failed;
  await expect(tab.locator("[data-reader-warning]")).toBeVisible();
  answer = "renewed";
  await tab.clock.runFor(31_000);
  await expect(tab.locator("[data-reader-warning]")).toHaveCount(0);
  // A first answer that fails is asked again: the warning arrives once the service says the Reader is silent.
  answer = "failing";
  const firstFailed = tab.waitForResponse((r) => r.url().endsWith("/api/v1/reader") && r.status() === 503);
  await tab.reload();
  await firstFailed;
  await expect(tab.getByRole("heading", { level: 1, name: "Jobs" })).toBeVisible();
  // Let the failed answer settle and its retry be armed before the clock moves on. React schedules its work on
  // message-channel tasks, which the fake clock leaves alone, so two round trips through one wait for it.
  const settle = () => tab.evaluate(() => new Promise<void>((r) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => r();
    channel.port2.postMessage(0);
  }));
  await settle();
  await settle();
  answer = "lapsed";
  await tab.clock.runFor(31_000);
  await expect(tab.locator("[data-reader-warning]")).toContainText("Work Mac");
  await tab.close();
});

test("narrow: a bottom bar with Home, Approvals, Search, Brain and More, and More holds Jobs, Connections, Settings and this Machine", async () => {
  const page = await journeys.open("/");
  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 800 });
    const bar = page.locator(".bottom-bar");
    await expect(bar).toBeVisible();
    await expect(page.locator(".masthead nav")).toBeHidden();
    await expect(bar.locator("a, button")).toHaveText([/^Home/, /^Approvals/, /^Search/, /^Brain/, /^More/]);
    const clipped = await bar.locator("a, button").evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth).map((el) => el.textContent));
    expect(clipped, `bottom bar labels cut off at ${width}px`).toEqual([]);
    expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `bottom bar fits at ${width}px`).toBe(true);
    for (const path of ["/", "/approvals", "/brain", "/jobs", "/connections", "/settings"]) {
      await page.goto(`${stack.url}${path}`);
      await expect(bar).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `horizontal overflow on ${path} at ${width}px`).toBeLessThanOrEqual(0);
    }
  }
  await page.setViewportSize({ width: 360, height: 800 });
  const bar = page.locator(".bottom-bar");
  await page.goto(stack.url);
  // On Home its own tab is selected and carries no number; Approvals keeps its count.
  await expect(bar.getByRole("link", { name: /^Home/ })).toHaveAttribute("aria-current", "page");
  await expect(bar.getByRole("link", { name: /^Home/ }).locator(".count")).toHaveCount(0);
  await expect(bar.getByRole("link", { name: "Approvals, 1 waiting" })).toBeVisible();

  // The last thing on a page scrolls clear of the bar, safe area included.
  await page.goto(`${stack.url}/settings`);
  await page.locator(".page").first().evaluate((el) => el.scrollTo(0, el.scrollHeight));
  const last = await page.locator(".page").first().evaluate((el) => {
    const kids = [...el.querySelectorAll("*")].filter((k) => (k as HTMLElement).offsetParent !== null && k.getBoundingClientRect().height > 0);
    return Math.max(...kids.map((k) => k.getBoundingClientRect().bottom));
  });
  expect(last, "last row above the bottom bar").toBeLessThanOrEqual((await bar.boundingBox())!.y);

  // More opens a sheet with the rest of the screens and this Machine.
  await bar.getByRole("button", { name: "More" }).click();
  const more = page.getByRole("dialog", { name: "More" });
  await expect(more).toBeVisible();
  await expect(more.getByRole("link")).toHaveText([/^Jobs/, /^Connections/, /^Settings/, /Machines and Replication/]);
  await expect(more.getByRole("region", { name: "This Machine" })).toContainText("This Machine runs Source refresh and briefings.");
  await more.getByRole("link", { name: /^Jobs/ }).click();
  await expect(more).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: "Jobs" })).toBeVisible();
  // Inside More the current screen is marked, and Escape gives focus back to More.
  await bar.getByRole("button", { name: "More" }).click();
  await expect(more.getByRole("link", { name: /^Jobs/ })).toHaveAttribute("aria-current", "page");
  await expect(bar.getByRole("button", { name: "More" })).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Escape");
  await expect(more).toBeHidden();
  await expect(bar.getByRole("button", { name: "More" })).toBeFocused();

  // Its Machines and Replication link goes to Settings in the same page, closing the sheet.
  await bar.getByRole("button", { name: "More" }).click();
  await page.evaluate(() => ((window as unknown as { stayed: boolean }).stayed = true));
  await more.getByRole("link", { name: /Machines and Replication/ }).click();
  await expect(more).toBeHidden();
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { stayed?: boolean }).stayed), "no full page load").toBe(true);

  // Search goes to the Brain's search field until Home has its own.
  await bar.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(`${stack.url}/brain`);
  await expect(page.getByRole("searchbox", { name: "Search the Brain" })).toBeFocused();
  await page.setViewportSize({ width: 1360, height: 900 });
});

test("no unresolved console errors across the shell journeys", () => {
  expect(journeys.consoleErrors).toEqual([]);
});
