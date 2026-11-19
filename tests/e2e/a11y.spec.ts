/**
 * The accessibility passes (#35 of spec #14) over every screen of the redesigned Dashboard: what a screen reader
 * meets (axe-core's WCAG 2.2 A/AA and best-practice rules, landmarks, Home's areas), no sideways scrolling at 320 px
 * or 200% zoom, the focus ring under forced colours, reduced motion, colour-vision simulation, 44 px targets and
 * viewport-safe first and last actions on a phone. Driven through the Dashboard against the real bundled service and
 * the TEST-ONLY fixtures (GitHub, Gmail, a notes folder, a Draft, a Proposal, a failed job and a briefing); set up
 * through the API, so it runs on its own.
 */
import { test, expect, type Page } from "@playwright/test";
import { api, JourneyBrowser } from "./browser.ts";
import { axeFindings, focusRing, overlaps, sideways, TARGET, targets } from "./a11y.ts";
import { openRow } from "./inbox.ts";
import { buildAll, startStack, type Stack } from "./stack.ts";

let stack: Stack;
let journeys: JourneyBrowser;
let draftId = "";
let jobId = "";
/** What axe found on Setup's first step and on the pairing screen, before the Dashboard was paired and set up. */
const before: string[] = [];
const beforeSideways: string[] = [];

const PHONE = { width: 375, height: 812 };
/** The home indicator's inset on a notched phone. */
const SAFE_AREA_BOTTOM = 34;
/** The triangle of the `warning` glyph (`components/icons.tsx`). */
const TRIANGLE = 'path[d^="M12 3.8 21 19.5H3z"]';

test.describe.configure({ mode: "default" });

/** axe's findings and any sideways overflow on a screen shown before pairing or setup, at desktop, 320 px and 200% zoom. */
async function checkBefore(page: Page, where: string) {
  before.push(...(await axeFindings(page)).map((f) => `${where}: ${f}`));
  for (const viewport of [{ width: 320, height: 640 }, { width: 640, height: 400 }]) {
    await page.setViewportSize(viewport);
    const s = await page.evaluate(sideways);
    if (s.document > 0 || s.page > 0 || s.outside.length) beforeSideways.push(`${where} at ${viewport.width} px: ${JSON.stringify(s)}`);
  }
  await page.setViewportSize({ width: 1360, height: 900 });
}

test.beforeAll(async ({ browser }) => {
  buildAll();
  stack = await startStack();
  journeys = await JourneyBrowser.start(browser, stack.url);
  // The pairing screen, in a browser the service has not paired.
  const stranger = await browser.newContext();
  const pairing = await stranger.newPage();
  await pairing.goto(stack.url);
  await expect(pairing.getByRole("heading", { level: 1 })).toBeVisible();
  await checkBefore(pairing, "pairing");
  await stranger.close();
  const page = await journeys.newPage();
  await page.goto(stack.pairUrl());
  await expect(page.getByRole("heading", { name: "Where should Attache keep your knowledge?" })).toBeVisible();
  await checkBefore(page, "setup");
  await api(page, "POST", "/setup/data-folder", { path: stack.dataDir });
  await api(page, "POST", "/setup/identity", { name: "Test User", email: "alex@example.com", confirm: true });
  await api(page, "POST", "/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${stack.fixtureUrl}/model`, model: "fixture-model" } });
  await api(page, "POST", "/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678" } });
  await api(page, "POST", "/connections/gmail/configure", { method: "claude-ai", fields: {} });
  await api(page, "POST", "/setup/complete");
  await api(page, "POST", "/import", { path: stack.vaultDir });
  await api(page, "POST", "/connections/github/refresh");
  await api(page, "POST", "/connections/gmail/refresh");
  type Item = { id: string; kind: string };
  let items: Item[] = [];
  await expect
    .poll(async () => (items = (await api<{ items: Item[] }>(page, "GET", "/attention?state=open")).items).map((i) => i.kind), { timeout: 60_000 })
    .toEqual(expect.arrayContaining(["review_request", "pending_reply", "deadline"]));
  await api(page, "POST", `/attention/${items.find((i) => i.kind === "review_request")!.id}/draft`, {});
  await expect.poll(async () => (draftId = (await api<Array<{ id: string }>>(page, "GET", "/actions?status=draft"))[0]?.id ?? ""), { timeout: 60_000 }).not.toBe("");
  await api(page, "POST", "/memory/proposals", { item: { action: "create", type: "person", title: "Lena Berg", facts: [{ subject: "Role", value: "Postmark account manager" }] }, reason: "Introduced in the vendor call" });
  jobId = (await api<{ job: { id: string } }>(page, "POST", "/jobs", { kind: "demo-long", title: "Diagnostics: a failing run", input: { steps: 1, stepMs: 10, failUntilAttempt: 1, maxAttempts: 1 } })).job.id;
  await api(page, "POST", "/briefings", { kind: "manual" });
  await expect.poll(async () => (await api<{ briefing: unknown }>(page, "GET", "/briefings/latest")).briefing !== null, { timeout: 30_000 }).toBe(true);
  await page.close();
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

const SETTINGS = ["features", "schedules", "identity", "saving", "meaning-search", "backup", "machines", "clients", "service"];

/** Every screen and subview, with the h1 it shows once it has loaded (a Draft's h1 is its title). */
const screens = (): ReadonlyArray<readonly [path: string, h1: string | null]> => [
  ["/", "Home"],
  ["/approvals", "Approvals"],
  ["/approvals?tab=finished", "Approvals"],
  [`/approvals/${draftId}`, null],
  ["/brain", "Brain"],
  ["/brain/recent", "Brain"],
  ["/connections", "Connections"],
  ["/jobs", "Jobs"],
  [`/jobs?id=${jobId}`, "Jobs"],
  ["/settings", "Settings"],
  ...SETTINGS.map((s) => [`/settings/${s}`, "Settings"] as const),
];

/** A screen once its requests have settled. */
async function arrive(page: Page, path: string, h1: string | null) {
  await page.goto(`${stack.url}${path}`);
  await expect(page.getByRole("heading", { level: 1, ...(h1 ? { name: h1, exact: true } : {}) })).toBeVisible();
  await page.waitForLoadState("networkidle");
}

/** Home's search results: a popup over the page, so its own controls are the ones to measure while it is open. */
const SEARCH_RESULTS = "Home's search results";

/**
 * The states a screen can be opened into, beyond how it arrives: a row, a note, the briefing, a sheet, the palette.
 * Each leaves the page in that state for a check; the next one starts from a fresh arrival.
 */
const OPENED: ReadonlyArray<readonly [where: string, path: string, h1: string, open: (page: Page) => Promise<void>]> = [
  ["Home with a row and Browse open", "/", "Home", async (page) => {
    await openRow(page.locator("#inbox [data-inbox-row]").first());
    await page.getByRole("button", { name: "Browse" }).click();
    await expect(page.getByRole("list", { name: "Browse the Brain" })).toBeVisible();
  }],
  [SEARCH_RESULTS, "/", "Home", async (page) => {
    await page.getByRole("combobox", { name: "Search the Brain" }).fill("Orion");
    await expect(page.getByRole("listbox", { name: "Results" }).getByRole("option").first()).toBeVisible();
  }],
  ["Home with the briefing read", "/", "Home", async (page) => {
    await page.getByRole("region", { name: "For you now" }).getByRole("button", { name: /Read briefing/ }).first().click();
    await expect(page.locator(".briefing-detail")).toBeVisible();
  }],
  ["Approvals with a Draft open", "/approvals", "Approvals", async (page) => {
    await page.locator("[data-approval-row] [data-row-toggle]").first().click();
    await expect(page.locator(".approval-detail").first()).toBeVisible();
  }],
  ["Connections with a row open", "/connections", "Connections", async (page) => {
    await page.locator("[data-connection] .connection-toggle").first().click();
    await expect(page.locator(".connection-detail").first()).toBeVisible();
  }],
  ["Brain with a note open", "/brain", "Brain", async (page) => {
    await page.locator(".note-list-item").first().click();
    await expect(page.locator("[data-note]")).toBeVisible();
  }],
  ["the shortcut sheet", "/", "Home", async (page) => {
    await page.locator(".home-head").click();
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  }],
  ["the search palette", "/jobs", "Jobs", async (page) => {
    await page.keyboard.press("Control+k");
    await page.keyboard.type("Orion");
    await expect(page.getByRole("dialog", { name: "Search the Brain" }).getByRole("option").nth(1)).toBeVisible();
  }],
];

test("screen reader: every screen, opened state, Setup and pairing pass axe's WCAG 2.2 A and AA and landmark rules, with one main, one banner and one h1", async () => {
  expect(before, "pairing and Setup").toEqual([]);
  const page = await journeys.open("/");
  for (const viewport of [{ width: 1360, height: 900 }, PHONE]) {
    await page.setViewportSize(viewport);
    for (const [path, h1] of screens()) {
      await arrive(page, path, h1);
      expect(await axeFindings(page), `${path} at ${viewport.width} px`).toEqual([]);
      await expect(page.getByRole("main"), path).toHaveCount(1);
      await expect(page.getByRole("banner"), path).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1 }), path).toHaveCount(1);
    }
  }
  await page.setViewportSize({ width: 1360, height: 900 });
  for (const [where, path, h1, open] of OPENED) {
    await arrive(page, path, h1);
    await open(page);
    expect(await axeFindings(page), where).toEqual([]);
  }
  await arrive(page, "/", "Home");
  await page.getByRole("button", { name: /^This Machine/ }).click();
  expect(await axeFindings(page), "the Machine panel").toEqual([]);
  await page.setViewportSize(PHONE);
  await arrive(page, "/", "Home");
  await page.locator(".bottom-bar").getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("dialog", { name: "More" })).toBeVisible();
  expect(await axeFindings(page), "the More sheet").toEqual([]);
  await page.setViewportSize({ width: 1360, height: 900 });
});

test("screen reader: Home's four areas are named in order, the navigation names counts in words and Home carries no badge on Home", async () => {
  const page = await journeys.open("/");
  const home = page.getByRole("region", { name: "Home" });
  await expect(home.getByRole("search", { name: "Brain" })).toBeVisible();
  await expect(home.getByRole("region", { name: "For you now" })).toBeVisible();
  await expect(home.getByRole("status", { name: "Connections" })).toBeVisible();
  await expect(home.getByRole("region", { name: "Inbox" })).toBeVisible();
  const order = await page.evaluate(() =>
    [".home-search", ".for-you-now", ".home-connections", "#inbox"].map((s) => document.querySelector(s)!.getBoundingClientRect().top),
  );
  expect(order, "search, For you now, Connections, Inbox from the top").toEqual([...order].sort((a, b) => a - b));
  for (const [viewport, bar] of [[{ width: 1360, height: 900 }, ".masthead-nav"], [PHONE, ".bottom-bar"]] as const) {
    await page.setViewportSize(viewport);
    const nav = page.locator(bar);
    // On Home the Home link names nothing waiting and shows no count: the Inbox heading says it.
    const homeLink = nav.getByRole("link", { name: "Home", exact: true });
    await expect(homeLink).toHaveAttribute("aria-current", "page");
    await expect(homeLink.locator(".count")).toHaveCount(0);
    // Elsewhere a count is spoken with its words, and the words on screen start the name (WCAG 2.5.3).
    const approvals = nav.getByRole("link", { name: /^Approvals, \d+ waiting$/ });
    await expect(approvals).toBeVisible();
    expect(await approvals.evaluate((a) => a.textContent!.replace(/\s+/g, " ").trim())).toMatch(/^Approvals \d+$/);
  }
  await page.setViewportSize({ width: 1360, height: 900 });
});

test("sideways: no screen or opened state scrolls sideways at 320 px or at 200% zoom", async () => {
  expect(beforeSideways, "pairing and Setup").toEqual([]);
  const page = await journeys.open("/");
  // 640 x 400 is a 1280 x 800 window at 200% zoom.
  for (const viewport of [{ width: 320, height: 640 }, { width: 640, height: 400 }]) {
    await page.setViewportSize(viewport);
    for (const [path, h1] of screens()) {
      await arrive(page, path, h1);
      expect(await page.evaluate(sideways), `${path} at ${viewport.width} px`).toEqual({ document: 0, page: 0, outside: [] });
    }
    for (const [where, path, h1, open] of OPENED) {
      await arrive(page, path, h1);
      await open(page);
      expect(await page.evaluate(sideways), `${where} at ${viewport.width} px`).toEqual({ document: 0, page: 0, outside: [] });
    }
    await arrive(page, "/", "Home");
    await page.screenshot({ path: `test-results/screens/${viewport.width === 320 ? "narrow-320" : "zoom-200"}-home.png` });
  }
  await page.setViewportSize({ width: 1360, height: 900 });
});

test("forced colours: every focus stop on every screen shows a 3 px ring in the system's Highlight", async () => {
  const page = await journeys.open("/");
  await page.emulateMedia({ forcedColors: "active" });
  for (const [path, h1] of screens()) {
    await arrive(page, path, h1);
    await page.locator("h1").click();
    const seen = new Set<string>();
    // Tab from the h1 until focus comes back round (or 80 stops).
    for (let i = 0; i < 80; i++) {
      await page.keyboard.press("Tab");
      const ring = await page.evaluate(focusRing);
      if (!ring || seen.has(ring.name)) break;
      seen.add(ring.name);
      expect(ring.style, `${path}: ${ring.name}`).toBe("solid");
      expect(ring.width, `${path}: ${ring.name}`).toBeGreaterThanOrEqual(3);
      expect(ring.colour, `${path}: ${ring.name}`).toBe(ring.highlight);
    }
    expect(seen.size, `${path} has focus stops`).toBeGreaterThan(0);
  }
  await arrive(page, "/", "Home");
  await page.getByRole("combobox", { name: "Search the Brain" }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await page.screenshot({ path: "test-results/screens/forced-colours-home-focus.png" });
  await page.emulateMedia({ forcedColors: "none" });
});

test("reduced motion: nothing animates, and a jump the Dashboard makes itself lands at once", async () => {
  const page = await journeys.open("/");
  await page.emulateMedia({ reducedMotion: "reduce" });
  const longest = () =>
    page.evaluate(() => {
      let most = 0;
      let what = "";
      for (const el of [document.documentElement, ...document.querySelectorAll("body *")]) {
        for (const pseudo of [null, "::before", "::after"]) {
          const s = getComputedStyle(el, pseudo);
          const times = [...s.transitionDuration.split(","), ...s.animationDuration.split(",")].map((t) => parseFloat(t) * (t.trim().endsWith("ms") ? 0.001 : 1));
          const t = Math.max(0, ...times.filter((n) => !Number.isNaN(n)));
          if (t > most) [most, what] = [t, `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}${pseudo ?? ""}`];
        }
      }
      return { most, what };
    });
  for (const [path, h1] of screens()) {
    await arrive(page, path, h1);
    const { most, what } = await longest();
    expect(most, `${path}: ${what}`).toBeLessThanOrEqual(0.001);
  }
  // Read briefing's count chips jump to the Inbox: in the same moment, not over the next frames.
  await page.setViewportSize({ width: 1280, height: 600 });
  await arrive(page, "/", "Home");
  await page.getByRole("region", { name: "For you now" }).getByRole("button", { name: /Read briefing/ }).first().click();
  const chip = page.getByRole("group", { name: "Briefing at a glance" }).getByRole("button").first();
  await expect(chip).toBeVisible();
  const jumped = await chip.evaluate((el) => {
    const scroller = document.querySelector(".page")!;
    const from = scroller.scrollTop;
    (el as HTMLElement).click();
    return scroller.scrollTop - from;
  });
  expect(jumped, "the page moved to the Inbox at once").toBeGreaterThan(0);
  await page.emulateMedia({ reducedMotion: null });
  await page.setViewportSize({ width: 1360, height: 900 });
});

test("colour vision: in grayscale and under each colour-vision deficiency every Inbox type keeps its own glyph and word, and a service failure keeps its warning triangle", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 1280, height: 800 });
  // Gmail's Connection fails: Home's Connections area shows it with the warning triangle.
  await page.route("**/api/v1/capabilities", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { connections: Array<{ kind: string; status: string; lastError: string | null }> };
    body.connections = body.connections.map((c) => (c.kind === "gmail" ? { ...c, status: "error", lastError: "The connector answered 503" } : c));
    await route.fulfill({ response: res, json: body });
  });
  await arrive(page, "/", "Home");
  const failure = page.locator('.home-connections .conn-row[data-state="down"]');
  await expect(failure).toContainText("Gmail");
  const cdp = await page.context().newCDPSession(page);
  const kinds = await page.locator("#inbox [data-inbox-row]").evaluateAll((rows) => [...new Set(rows.map((r) => r.getAttribute("data-type")!))]);
  expect(kinds.length, "the Inbox shows several types").toBeGreaterThanOrEqual(3);
  for (const vision of ["achromatopsia", "protanopia", "deuteranopia", "tritanopia"] as const) {
    await cdp.send("Emulation.setEmulatedVisionDeficiency", { type: vision });
    const stamps: Buffer[] = [];
    for (const kind of kinds) {
      const row = page.locator(`#inbox [data-inbox-row][data-type="${kind}"]`).first();
      await row.scrollIntoViewIfNeeded();
      await expect(row.locator(".inbox-kind-word"), `${vision}: ${kind} has its word`).not.toBeEmpty();
      stamps.push(await row.locator(".type-icon").screenshot());
    }
    const same = kinds.flatMap((a, i) => kinds.slice(i + 1).filter((_, j) => stamps[i]!.equals(stamps[i + 1 + j]!)).map((b) => `${a} = ${b}`));
    expect(same, `${vision}: stamps that cannot be told apart`).toEqual([]);
    await page.locator(".page").evaluate((el) => el.scrollTo(0, 0));
    await expect(failure.locator(`svg ${TRIANGLE}`), `${vision}: the warning triangle`).toBeVisible();
    await page.screenshot({ path: `test-results/screens/${vision === "achromatopsia" ? "grayscale" : vision}-home.png` });
  }
  await cdp.send("Emulation.setEmulatedVisionDeficiency", { type: "none" });
  await page.unroute("**/api/v1/capabilities");
  await page.setViewportSize({ width: 1360, height: 900 });
});

test("targets: on a touch phone every control on every screen is a 44 x 44 target a tap reaches, apart from its neighbours", async ({ browser }) => {
  const phone = await JourneyBrowser.start(browser, stack.url, { storageState: await journeys.context.storageState(), hasTouch: true, isMobile: true, viewport: PHONE });
  const page = await phone.open("/");
  const check = async (where: string) => {
    await page.mouse.move(1, 1);
    const found = await page.evaluate(targets, where === SEARCH_RESULTS ? ".home-search .search" : ".page, .masthead, .bottom-bar, dialog[open]");
    const small = found.filter((t) => t.width < TARGET - 0.01 || t.height < TARGET - 0.01).map((t) => `${t.name} ${Math.round(t.width)}x${Math.round(t.height)}`);
    expect(small, `${where}: targets under ${TARGET} px`).toEqual([]);
    expect(found.filter((t) => !t.hit).map((t) => t.name), `${where}: targets a tap does not reach`).toEqual([]);
    expect(found.filter((t) => t.clipped).map((t) => t.name), `${where}: targets with words cut off`).toEqual([]);
    const touching = found.flatMap((a, i) => found.slice(i + 1).filter((b) => overlaps(a, b)).map((b) => `${a.name} / ${b.name}`));
    expect(touching, `${where}: overlapping targets`).toEqual([]);
  };
  for (const [path, h1] of screens()) {
    await arrive(page, path, h1);
    await check(path);
  }
  for (const [where, path, h1, open] of OPENED.filter(([w]) => !/sheet|palette/.test(w))) {
    await arrive(page, path, h1);
    await open(page);
    await check(where);
  }
  expect(phone.consoleErrors).toEqual([]);
  await phone.close();
});

test("first and last actions: on a phone with a home indicator, each screen's first and last controls sit between the masthead and the bottom bar, where a tap reaches them", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize(PHONE);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: SAFE_AREA_BOTTOM } });
  for (const [path, h1] of screens()) {
    await arrive(page, path, h1);
    for (const which of ["first", "last"] as const) {
      const place = await page.evaluate((end) => {
        const scroller = document.querySelector<HTMLElement>(".page")!;
        scroller.scrollTo(0, end === "last" ? scroller.scrollHeight : 0);
        const controls = [...scroller.querySelectorAll<HTMLElement>("a[href], button:not([tabindex='-1']), summary, select, input, textarea")].filter(
          (el) => el.checkVisibility({ visibilityProperty: true }) && !el.closest(".sr-only"),
        );
        const el = end === "last" ? controls.at(-1)! : controls[0]!;
        const r = el.getBoundingClientRect();
        const top = document.querySelector(".masthead")!.getBoundingClientRect().bottom;
        const bottom = document.querySelector(".bottom-bar")!.getBoundingClientRect().top;
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { name: (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40), inside: r.top >= top - 0.5 && r.bottom <= bottom + 0.5, hit: at !== null && (at === el || el.contains(at)) };
      }, which);
      expect(place, `${path}: ${which} control`).toEqual({ name: place.name, inside: true, hit: true });
    }
  }
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: {} });
  await page.setViewportSize({ width: 1360, height: 900 });
});

test("no unresolved console errors across the passes", () => {
  expect(journeys.consoleErrors).toEqual([]);
});


