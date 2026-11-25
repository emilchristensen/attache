/**
 * The accessibility passes (#35 of spec #14) over every screen of the redesigned Dashboard: what a screen reader
 * meets (axe-core's WCAG 2.2 A/AA and best-practice rules, landmarks, Home's areas), no sideways scrolling at 320 px
 * or 200% zoom, the focus ring under forced colours, reduced motion, colour-vision simulation, 44 px targets and
 * viewport-safe first and last actions on a phone. Driven through the Dashboard against the real bundled service and
 * the TEST-ONLY fixtures (GitHub, Gmail, a notes folder, a Draft, a Proposal, a failed job and a briefing); set up
 * through the API, so it runs on its own.
 */
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, JourneyBrowser, nextFrames } from "./browser.ts";
import { axeFindings, focusRing, overlaps, sideways, TARGET, targets } from "./a11y.ts";
import { openRow } from "./inbox.ts";
import { buildAll, harnessSave, startStack, type Stack } from "./stack.ts";

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

test.describe.configure({ mode: "serial" });

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
  // Two people in one collection, so a note in the list can be seen chosen and not chosen.
  await harnessSave(stack, [{ action: "create", type: "person", title: "Sam Berg", facts: [{ subject: "Role", value: "Client contact" }] }], { agent: "claude-code", session: "a11y" });
  // Nora's role was due for review in February, written by hand as the owner might, so a Fact to check cites her
  // note: its evidence view offers Open in Brain.
  mkdirSync(join(stack.dataDir, "memory/people"), { recursive: true });
  writeFileSync(join(stack.dataDir, "memory/people/nora-lind.md"), "# Nora Lind\n\n## Current state\n- **Role** (2026-01-01, review 2026-02-01): Client contact\n");
  await expect.poll(async () => (await api<Array<{ relPath: string }>>(page, "GET", "/memory/documents?area=memory")).some((d) => d.relPath === "memory/people/nora-lind.md"), { timeout: 30_000 }).toBe(true);
  await api(page, "POST", "/connections/vault-data/refresh");
  await expect.poll(async () => (await api<{ items: Item[] }>(page, "GET", "/attention?state=open")).items.map((i) => i.kind), { timeout: 30_000 }).toContain("fact-review");
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

/** A modal over the page (a sheet, the palette, the evidence view): while one is open, only its controls can be tapped. */
const MODAL = 'dialog[open], [aria-modal="true"]';

/** The evidence view of a curated note, with Open in Brain. */
const EVIDENCE = "the evidence view";

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
  ["The briefing page Read briefing opens", "/", "Home", async (page) => {
    // The only briefing here is one asked for: its page carries its own name, not the Daily Briefing's.
    await page.getByRole("region", { name: "The Daily Briefing" }).getByRole("link", { name: "Read briefing" }).first().click();
    await expect(page.getByRole("heading", { level: 1, name: "Briefing you asked for" })).toBeVisible();
    await expect(page.locator(".briefing-detail")).toBeVisible();
  }],
  [EVIDENCE, "/", "Home", async (page) => {
    const fact = page.locator("#inbox [data-inbox-row]", { has: page.locator(".inbox-kind-word", { hasText: "Fact to check" }) }).first();
    await openRow(fact);
    await fact.locator(".source-chip").first().click();
    await expect(page.getByRole("dialog", { name: /Evidence/ }).getByRole("link", { name: "Open in Brain" })).toBeVisible();
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

test("screen reader: Home's five areas are named in order, the navigation names counts in words and Home carries no badge on Home", async () => {
  const page = await journeys.open("/");
  const home = page.getByRole("region", { name: "Home" });
  await expect(home.getByRole("search", { name: "Brain" })).toBeVisible();
  await expect(home.getByRole("region", { name: "The Daily Briefing" })).toBeVisible();
  await expect(home.getByRole("region", { name: "For you now" })).toBeVisible();
  await expect(home.getByRole("region", { name: "Your day" })).toBeVisible();
  await expect(home.getByRole("region", { name: "Inbox" })).toBeVisible();
  const tops = (selectors: readonly string[]) => page.evaluate((all) => all.map((s) => document.querySelector(s)!.getBoundingClientRect().top), selectors);
  // On a desktop window Your day spans the column above For you now and the Inbox, which share a row; the reading
  // order follows it, so the keyboard never goes back up the page.
  const wide = await tops([".home-search", ".daily-briefing-area", ".your-day", ".for-you-now", "#inbox"]);
  expect(wide.slice(0, 4), "search, The Daily Briefing, Your day, For you now from the top").toEqual([...wide.slice(0, 4)].sort((a, b) => a - b));
  expect(Math.abs(wide[3]! - wide[4]!), "For you now and the Inbox share a row").toBeLessThanOrEqual(1);
  // On a phone For you now comes before Your day, once Home has put the areas in the phone's order.
  await page.setViewportSize(PHONE);
  const phoneOrder = [".home-search", ".daily-briefing-area", ".for-you-now", ".your-day", "#inbox"];
  await expect.poll(async () => {
    const narrow = await tops(phoneOrder);
    return narrow.every((top, i) => i === 0 || narrow[i - 1]! <= top);
  }, { message: "search, The Daily Briefing, For you now, Your day, Inbox from the top" }).toBe(true);
  await page.setViewportSize({ width: 1360, height: 900 });
  // Five areas and nothing else (the shared row holds Your day, For you now and the Inbox): Recently added closes the
  // Inbox area rather than standing as a sixth.
  await expect(home.locator(":scope > :not(.home-areas), :scope > .home-areas > *")).toHaveCount(5);
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

test("screen reader: the decision count is read out when a Source refresh changes it, and never on load or for the owner's own decision", async () => {
  const page = await journeys.open("/");
  const said = page.locator("[data-count-announcement]");
  await expect(said).toHaveAttribute("role", "status");
  const total = async () => Number((await page.title()).match(/^\((\d+)\)/)?.[1] ?? 0);
  await expect.poll(total).toBeGreaterThan(0);
  await page.waitForLoadState("networkidle");
  await expect(said).toHaveText("");
  // The owner's own decision changes the count without a word.
  const before = await total();
  const open = (await api<{ items: Array<{ id: string; kind: string }> }>(page, "GET", "/attention?state=open")).items;
  const item = open.find((i) => i.kind === "pending_reply")!;
  await api(page, "POST", `/attention/${item.id}/decision`, { decision: "done" });
  await expect.poll(total).toBe(before - 1);
  // The count and the words come from one render: once that render is painted, nothing was said.
  await nextFrames(page);
  expect(await said.textContent()).toBe("");
  // A Source refresh that finds a new deadline is read out with the new total.
  const notes = (await api<Array<{ id: string; kind: string }>>(page, "GET", "/connections")).find((c) => c.kind === "vault" && c.id !== "vault-data")!;
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  writeFileSync(join(stack.vaultDir, "Projects/Announce.md"), `# Announce\n\n## Tasks\n- [ ] Book the venue 📅 ${tomorrow}\n`);
  await api(page, "POST", `/connections/${notes.id}/refresh`);
  await expect(said).toHaveText(`${before} need you now.`);
  await expect.poll(total).toBe(before);
  // A decision made while a refresh that finds nothing new runs is the owner's own: nothing more is read out.
  const heard = () => said.evaluate((el) => el.textContent);
  const was = await heard();
  const other = open.find((i) => i.kind === "deadline")!;
  await Promise.all([api(page, "POST", `/connections/${notes.id}/refresh`), api(page, "POST", `/attention/${other.id}/decision`, { decision: "done" })]);
  await expect.poll(total).toBe(before - 1);
  // Undoing the decision is a later live update than the refresh's own, so once its count shows, the page has heard
  // the refresh out and said all it was going to say.
  await api(page, "POST", `/attention/${other.id}/decision`, { decision: "reopen" });
  await expect.poll(total).toBe(before);
  await nextFrames(page);
  expect(await heard()).toBe(was);
  // Undo the decision, so the other passes see the same Inbox.
  await api(page, "POST", `/attention/${item.id}/decision`, { decision: "reopen" });
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
    // From the document's first stop (the skip link; a screen like Settings focuses its section on arrival), Tab
    // through the masthead and the page until focus leaves the document or comes back to an element it already
    // visited, so every stop is checked, also several that share a name.
    await page.locator(".skip-link").focus();
    let stops = 0;
    let masthead = false;
    for (; stops < 300; stops++) {
      if (stops > 0) await page.keyboard.press("Tab");
      const ring = await page.evaluate(focusRing);
      if (!ring || ring.visited) break;
      masthead ||= ring.masthead;
      expect(ring.style, `${path}: ${ring.name}`).toBe("solid");
      expect(ring.width, `${path}: ${ring.name}`).toBeGreaterThanOrEqual(3);
      expect(ring.colour, `${path}: ${ring.name}`).toBe(ring.highlight);
    }
    expect(masthead, `${path}: the walk went through the masthead`).toBe(true);
    expect(stops, `${path}: the Tab order ended`).toBeLessThan(300);
  }
  await arrive(page, "/", "Home");
  await page.getByRole("combobox", { name: "Search the Brain" }).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await page.screenshot({ path: "test-results/screens/forced-colours-home-focus.png" });
  await page.emulateMedia({ forcedColors: "none" });
});

test("forced colours: the selected screen, tab, collection, note, job, Settings section and search result stay marked, and the attention dot stays drawn", async () => {
  const page = await journeys.open("/");
  await page.emulateMedia({ forcedColors: "active" });
  await page.mouse.move(1, 1);
  /** The same element drawn while `select` has chosen it and while `other` has: the two must not look alike. */
  const marked = async (what: string, at: (page: Page) => ReturnType<Page["locator"]>, select: () => Promise<void>, other: () => Promise<void>) => {
    await select();
    await page.mouse.move(1, 1);
    const on = await at(page).screenshot({ animations: "disabled", caret: "hide" });
    await other();
    await page.mouse.move(1, 1);
    const off = await at(page).screenshot({ animations: "disabled", caret: "hide" });
    expect(on.equals(off), `${what}: chosen and not chosen look the same`).toBe(false);
  };
  const go = (path: string, h1: string) => () => arrive(page, path, h1);
  await marked("the masthead's screen", (p) => p.locator(".masthead-nav").getByRole("link", { name: "Brain", exact: true }), go("/brain", "Brain"), go("/jobs", "Jobs"));
  await marked("a tab", (p) => p.getByRole("tab", { name: "Recent saves" }), go("/brain/recent", "Brain"), go("/brain", "Brain"));
  await marked("a collection", (p) => p.getByRole("navigation", { name: "Collections" }).getByRole("link", { name: "Projects" }), go("/brain?tab=project", "Brain"), go("/brain?tab=person", "Brain"));
  const notes = page.locator(".note-list-item");
  await arrive(page, "/brain?tab=person", "Brain");
  await expect(notes).not.toHaveCount(1);
  const [first, second] = [await notes.nth(0).getAttribute("href"), await notes.nth(1).getAttribute("href")];
  await marked("a note in the list", () => notes.nth(0), go(first!, "Brain"), go(second!, "Brain"));
  await page.screenshot({ path: "test-results/screens/forced-colours-brain-note.png" });
  await marked("a Settings section", (p) => p.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: "Features" }), go("/settings/features", "Settings"), go("/settings/schedules", "Settings"));
  await marked("a job", (p) => p.locator(`[data-job-row] .job-pick`).first(), async () => {
    await arrive(page, "/jobs", "Jobs");
    await page.locator("[data-job-row] .job-pick").first().click();
  }, async () => {
    await page.locator("[data-job-row] .job-pick").nth(1).click();
  });
  await arrive(page, "/", "Home");
  const field = page.getByRole("combobox", { name: "Search the Brain" });
  await field.fill("Orion");
  const option = page.getByRole("listbox", { name: "Results" }).getByRole("option").first();
  await expect(option).toHaveAttribute("aria-selected", "true");
  await marked("a search result", () => option, async () => {}, () => field.press("ArrowDown"));
  await field.press("Escape");
  // The brass dot beside the Inbox's count keeps a colour of its own against the page.
  const dot = await page.locator("#inbox .attention-dot").evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = "Canvas";
    document.body.append(probe);
    const canvas = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { dot: getComputedStyle(el).backgroundColor, canvas };
  });
  expect(dot.dot, "the attention dot").not.toBe(dot.canvas);
  expect(dot.dot, "the attention dot").not.toBe("rgba(0, 0, 0, 0)");
  await page.emulateMedia({ forcedColors: "none" });
});

test("keyboard: the evidence view keeps Tab and Shift+Tab inside it until it closes, then gives focus back, and Open in Brain closes it", async () => {
  const page = await journeys.open("/");
  const [, path, h1, open] = OPENED.find(([w]) => w === EVIDENCE)!;
  await arrive(page, path, h1);
  await open(page);
  const drawer = page.getByRole("dialog", { name: /Evidence/ });
  await expect(drawer.getByRole("button", { name: "Close evidence" })).toBeFocused();
  for (const key of ["Shift+Tab", "Tab"]) {
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press(key);
      expect(await drawer.evaluate((d) => d.contains(document.activeElement)), `${key} ${i + 1}`).toBe(true);
    }
  }
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(page.locator("#inbox .source-chip").first()).toBeFocused();
  // Open in Brain goes there and closes the evidence view, so the keyboard carries on in the Brain.
  await page.keyboard.press("Enter");
  await drawer.getByRole("link", { name: "Open in Brain" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/brain\?path=memory%2Fpeople%2Fnora-lind\.md/);
  await expect(drawer).toBeHidden();
  await expect(page.locator("[data-note] h2.detail-title")).toHaveText("Nora Lind");
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => document.activeElement !== document.body && !document.activeElement?.closest(".drawer"))).toBe(true);
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
  await page.emulateMedia({ reducedMotion: null });
  await page.setViewportSize({ width: 1360, height: 900 });
});

test("colour vision: in grayscale and under each colour-vision deficiency every Inbox type keeps its own glyph and word, and a service failure keeps its warning triangle", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 1280, height: 800 });
  // Gmail's Connection fails: the shell banner shows it with the warning triangle.
  await page.route("**/api/v1/capabilities", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { connections: Array<{ kind: string; status: string; lastError: string | null }> };
    body.connections = body.connections.map((c) => (c.kind === "gmail" ? { ...c, status: "error", lastError: "The connector answered 503" } : c));
    await route.fulfill({ response: res, json: body });
  });
  await arrive(page, "/", "Home");
  const failure = page.locator('[data-connection-banner][data-state="down"]');
  await expect(failure).toContainText("Gmail");
  const cdp = await page.context().newCDPSession(page);
  const kinds = await page.locator("#inbox [data-inbox-row]").evaluateAll((rows) => [...new Set(rows.map((r) => r.getAttribute("data-type")!))]);
  // The stack's GitHub, Gmail and notes raise these three, the pair the spec names (review vs reply) among them.
  expect(kinds).toEqual(expect.arrayContaining(["review_request", "pending_reply", "deadline"]));
  // Each type has its own word and its own glyph, whatever its fill: told apart without colour.
  const looks = await Promise.all(
    kinds.map((kind) => page.locator(`#inbox [data-inbox-row][data-type="${kind}"]`).first().locator(".inbox-kind").evaluate((k) => ({ word: k.querySelector(".inbox-kind-word")!.textContent!, glyph: k.querySelector("svg")!.innerHTML }))),
  );
  expect(new Set(looks.map((l) => l.word)).size, "one word per type").toBe(kinds.length);
  expect(new Set(looks.map((l) => l.glyph)).size, "one glyph per type").toBe(kinds.length);
  for (const vision of ["achromatopsia", "protanopia", "deuteranopia", "tritanopia"] as const) {
    await cdp.send("Emulation.setEmulatedVisionDeficiency", { type: vision });
    const stamps: Buffer[] = [];
    for (const kind of kinds) {
      const row = page.locator(`#inbox [data-inbox-row][data-type="${kind}"]`).first();
      await row.scrollIntoViewIfNeeded();
      await expect(row.locator(".inbox-kind-word"), `${vision}: ${kind} has its word`).not.toBeEmpty();
      // The glyph alone, on a transparent stamp, so a difference in fill cannot stand in for a different glyph.
      await row.locator(".type-icon").evaluate((el) => ((el as HTMLElement).style.background = "transparent"));
      stamps.push(await row.locator(".type-icon").screenshot());
      await row.locator(".type-icon").evaluate((el) => ((el as HTMLElement).style.background = ""));
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

for (const [device, viewport] of [["phone", PHONE], ["tablet", { width: 1024, height: 768 }]] as const) {
test(`targets: on a touch ${device} every control on every screen, sheet and dialog is a 44 x 44 target a tap reaches, apart from its neighbours`, async ({ browser }) => {
  const phone = await JourneyBrowser.start(browser, stack.url, { storageState: await journeys.context.storageState(), hasTouch: true, isMobile: true, viewport });
  const page = await phone.open("/");
  const check = async (where: string) => {
    await page.mouse.move(1, 1);
    const found = await page.evaluate(targets, where === SEARCH_RESULTS ? ".home-search .search" : (await page.locator(MODAL).count()) ? MODAL : ".page, .masthead, .bottom-bar");
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
  // A Machine name longer than its field (a CI runner's host name is) scrolls inside the field and is not cut off.
  await arrive(page, "/settings/machines", "Settings");
  await page.locator("[data-machine-name]").fill("a-very-long-machine-name-from-a-build-runner-0123456789abcdef");
  await check("Machines with a long name typed");
  for (const [where, path, h1, open] of OPENED) {
    await arrive(page, path, h1);
    await open(page);
    await check(where);
  }
  expect(phone.consoleErrors).toEqual([]);
  await phone.close();
});
}

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


