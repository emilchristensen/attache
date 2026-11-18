/**
 * Search the Brain on Home (#21 of spec #14): the compact heading and date, the one search field and its results,
 * the keys that focus it and Browse, driven through the Dashboard against the real bundled service and the
 * TEST-ONLY fixtures.
 */
import { test, expect, type Page } from "@playwright/test";
import { api, JourneyBrowser } from "./browser.ts";
import { lineStarts } from "./layout.ts";
import { buildAll, harnessSave, startStack, type Stack } from "./stack.ts";

let stack: Stack;
let journeys: JourneyBrowser;

test.describe.configure({ mode: "serial" });

/** Eight projects share a word, more than the six results the field shows. */
const HELIOS = Array.from({ length: 8 }, (_, i) => `Helios workstream ${i + 1}`);
const VENDOR = "memory/decisions/email-vendor.md";
/** Px from the top of the page to the next area on Home at 1280 x 800, arithmetic in the first journey. */
const BUDGET = 136;

test.beforeAll(async ({ browser }) => {
  buildAll();
  stack = await startStack();
  journeys = await JourneyBrowser.start(browser, stack.url);
  const page = await journeys.newPage();
  await page.goto(stack.pairUrl());
  await expect(page.getByRole("heading", { name: "Where should Attache keep your knowledge?" })).toBeVisible();
  await api(page, "POST", "/setup/data-folder", { path: stack.dataDir });
  await api(page, "POST", "/setup/identity", { name: "Test User", email: "alex@example.com", confirm: true });
  await api(page, "POST", "/setup/complete");
  await api(page, "POST", "/import", { path: stack.vaultDir });
  await harnessSave(stack, HELIOS.map((title, i) => ({ action: "create", type: "project", title, facts: [{ subject: "Status", value: `Helios phase ${i + 1} is on track` }] })), { agent: "claude-code", session: "sess-e2e-helios" });
  await harnessSave(stack, [{ action: "create", type: "decision", title: "Email vendor", facts: [{ subject: "Decision", value: "Switch to Postmark for 2027" }] }], { agent: "claude-code", session: "sess-e2e-vendor" });
  // The import runs as a job; search finds the imported notes once it has indexed them.
  await expect.poll(async () => (await api<{ hits: unknown[] }>(page, "GET", "/memory/search?q=Orion")).hits.length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.close();
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

const field = (page: Page) => page.getByRole("combobox", { name: "Search the Brain" });
const results = (page: Page) => page.getByRole("listbox", { name: "Results" });

/**
 * Presses `key` with the editing command macOS gives it (`End` scrolls to the end of the document there), on every
 * system, so the journey covers what a Mac does whichever system runs it.
 */
async function pressAsOnMac(page: Page, key: "Home" | "End") {
  const command = key === "Home" ? "scrollToBeginningOfDocument" : "scrollToEndOfDocument";
  const code = key === "Home" ? 36 : 35;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: key, windowsVirtualKeyCode: code, commands: [command] });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: code });
  await cdp.detach();
}

/** Whether the open results list is no taller than the visible page under its top, and its foot ends inside it. */
async function resultsFit(page: Page): Promise<{ top: boolean; bottom: boolean }> {
  return results(page).evaluate((list) => {
    const area = list.closest(".page")!.getBoundingClientRect();
    const top = Math.max(0, area.top);
    const bottom = Math.min(window.innerHeight, area.bottom);
    return { top: list.getBoundingClientRect().height <= bottom - top, bottom: list.parentElement!.getBoundingClientRect().bottom <= bottom };
  });
}

/** The placeholder's width in the field's own font, against the room the field gives it. */
async function promptFits(page: Page): Promise<{ text: number; room: number }> {
  return field(page).evaluate((input: HTMLInputElement) => {
    const style = getComputedStyle(input);
    const ctx = document.createElement("canvas").getContext("2d")!;
    ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    return { text: ctx.measureText(input.placeholder).width, room: input.clientWidth };
  });
}

test("home: a compact heading and today's date over one search field, not focused on arrival and with no repeated headline", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  const weekday = new Date().toLocaleDateString("en-GB", { weekday: "long" });
  await expect(page.locator(".home-head time")).toContainText(weekday);
  const search = field(page);
  await expect(search).toBeVisible();
  await expect(search).not.toBeFocused();
  await expect(search).toHaveAttribute("placeholder", "Search the Brain");
  await expect(search).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("heading", { name: "Search the Brain" })).toHaveCount(0);
  // About 54 px, with the keycap that names the shortcut.
  const box = (await page.locator(".search-home .search-box").boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(52);
  expect(box.height).toBeLessThanOrEqual(58);
  await expect(page.locator(".search-home .search-key")).toHaveText(/^(Ctrl K|⌘ K)$/);
  await expect(page.locator(".search-home .search-key")).toBeVisible();
  // Its share of the first viewport (#25's fold budget): the page's 24 px top padding, the 18 px heading line and
  // its 12 px gap, the 54 px field with its 3 px ruled shadow, and the 24 px before the next area = 135 px.
  const share = await page.locator(".home-search").evaluate((area) => {
    const page = area.closest(".page")!.getBoundingClientRect().top;
    return area.getBoundingClientRect().bottom + parseFloat(getComputedStyle(area).marginBottom) - page;
  });
  expect(share, "Search the Brain's share of the first viewport").toBeLessThanOrEqual(BUDGET);
  // On Home the masthead needs no search launcher: the field is right here.
  await expect(page.getByRole("button", { name: /^Search the Brain/ })).toHaveCount(0);
});

test("home: typing shows up to six cited results ranked by keywords only, Esc closes them and keeps the text, and search changes nothing", async () => {
  const page = await journeys.open("/");
  const jobsBefore = (await api<Array<{ id: string }>>(page, "GET", "/jobs?limit=100")).length;
  const writes: string[] = [];
  page.on("request", (r) => {
    if (r.method() !== "GET") writes.push(`${r.method()} ${r.url()}`);
  });
  await expect(field(page)).toBeVisible();
  await page.keyboard.press("/");
  const search = field(page);
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("");
  await page.keyboard.type("Helios");
  const list = results(page);
  await expect(list).toBeVisible();
  const options = list.getByRole("option");
  await expect(options).toHaveCount(6);
  await expect(search).toHaveAttribute("aria-expanded", "true");
  // The first result is chosen; each says its title, snippet, kind and file with its lines.
  const first = options.first();
  await expect(first).toHaveAttribute("aria-selected", "true");
  await expect(search).toHaveAttribute("aria-activedescendant", (await first.getAttribute("id"))!);
  await expect(first.locator(".search-hit-name")).toHaveText(/^Helios workstream \d$/);
  await expect(first.locator(".search-hit-snippet")).toContainText("Helios");
  await expect(first.locator(".search-hit-kind")).toHaveText("Project");
  await expect(first.locator(".search-hit-place")).toHaveText(/^memory\/projects\/helios-workstream-\d\.md:\d+(-\d+)?$/);
  await expect(page.locator(".search-home [data-ranking]")).toHaveText("Ranked by keywords only: the meaning model is not downloaded. Settings");
  await expect(page.locator(".search-home").getByRole("status")).toHaveText("6 results");

  // Arrow keys choose; Esc closes the results and keeps the text; an arrow opens them again.
  await page.keyboard.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(options.nth(5)).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Escape");
  await expect(list).toBeHidden();
  await expect(search).toHaveValue("Helios");
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowDown");
  await expect(list).toBeVisible();

  // A miss says so.
  await search.fill("zyxwvut");
  await expect(page.locator(".search-home .search-status")).toHaveText("No passages match “zyxwvut”. Try other words.");
  await expect(options).toHaveCount(0);

  // Searching started no job and sent nothing but reads.
  expect(writes).toEqual([]);
  expect((await api<Array<{ id: string }>>(page, "GET", "/jobs?limit=100")).length).toBe(jobsBefore);
});

test("home: Enter opens evidence at the cited lines and returns to the field; a memory note opens in the Brain", async () => {
  const page = await journeys.open("/");
  const search = field(page);
  await search.fill("cutover plan finance");
  await expect(results(page).getByRole("option").first()).toContainText("Orion");
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: /Evidence/ });
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".line.hl").first()).toBeVisible();
  expect(await drawer.locator(".line.hl").allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining("Send the cutover plan to finance")]));
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("cutover plan finance");

  await search.fill("Postmark");
  const vendor = results(page).getByRole("option", { name: /Email vendor/ });
  await expect(vendor).toBeVisible();
  await expect(vendor.locator(".search-hit-kind")).toHaveText("Decision");
  await vendor.click();
  await expect(page).toHaveURL(`${stack.url}/brain?root=data&path=${encodeURIComponent(VENDOR)}&q=Postmark`);
  await expect(page.locator('[data-subject="Decision"]')).toContainText("Switch to Postmark for 2027");
  await expect(page.getByRole("searchbox", { name: "Search the Brain" })).toHaveValue("Postmark");
});

test("home: All results in Brain carries the query to the Brain screen's address", async () => {
  const page = await journeys.open("/");
  await field(page).fill("Helios");
  await expect(results(page).getByRole("option")).toHaveCount(6);
  await page.getByRole("link", { name: "All results in Brain" }).click();
  await expect(page).toHaveURL(`${stack.url}/brain?q=Helios`);
  await expect(page.getByRole("heading", { level: 1, name: "Brain" })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search the Brain" })).toHaveValue("Helios");
  // More than the six Home showed: every Helios project is among them.
  for (const title of HELIOS) await expect(page.locator(".split .list-item", { hasText: title }).first()).toBeVisible();
  // Typing in the Brain keeps the address in step, and Back returns to Home.
  await page.getByRole("searchbox", { name: "Search the Brain" }).fill("Orion");
  await expect(page).toHaveURL(`${stack.url}/brain?q=Orion`);
  await page.goBack();
  await expect(page).toHaveURL(`${stack.url}/`);
  await expect(field(page)).toBeVisible();

  // Enter with nothing chosen goes to all results too.
  await field(page).fill("zyxwvut");
  await expect(page.locator(".search-home .search-status")).toContainText("No passages match");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${stack.url}/brain?q=zyxwvut`);
});

test("home: only the answer to what the field says now can be opened; keys follow the chosen result and Esc works from the results", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 1280, height: 420 });
  const search = field(page);
  await search.fill("Helios");
  const options = results(page).getByRole("option");
  await expect(options).toHaveCount(6);
  // The chosen result stays in view as the arrow keys move past the window's edge.
  await page.keyboard.press("ArrowUp");
  await expect(options.nth(5)).toHaveAttribute("aria-selected", "true");
  await expect(options.nth(5)).toBeInViewport();
  // The results scroll on their own, so the field the owner types in stays in view.
  await expect(search).toBeInViewport();
  // Home and End move the caret in the text, also on macOS, where they would otherwise scroll the page away.
  await search.press("Home");
  expect(await search.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(0);
  await pressAsOnMac(page, "End");
  expect(await search.evaluate((input: HTMLInputElement) => input.selectionStart)).toBe("Helios".length);
  expect(await page.locator(".page").evaluate((el) => el.scrollTop)).toBe(0);
  // Refined words bring a new answer, shown from its first result, which Enter would open.
  await page.keyboard.type(" workstream");
  await expect(search).toHaveValue("Helios workstream");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await expect(options.first()).not.toHaveAttribute("aria-disabled", "true");
  await expect(options.first()).toBeInViewport();
  expect(await results(page).evaluate((el) => el.scrollTop)).toBe(0);
  // Results that answer while the page is scrolled past the field still fit what shows of the page once it is
  // scrolled back, so they never hang past its bottom. The answer is held until the page is scrolled, since typing
  // scrolls the field back into view.
  const pageArea = page.locator(".page");
  let answer!: () => void;
  const scrolled = new Promise<void>((resolve) => (answer = resolve));
  await page.route(/\/api\/v1\/memory\/search\?q=Helios(%20|\+)workstrea&/, (route) => scrolled.then(() => route.continue()), { times: 1 });
  await search.press("Backspace");
  await expect(search).toHaveValue("Helios workstrea");
  await expect(options.first()).toHaveAttribute("aria-disabled", "true");
  await pageArea.evaluate((el) => el.scrollTo(0, el.scrollHeight));
  const fieldHidden = () => search.evaluate((input) => input.getBoundingClientRect().bottom < input.closest(".page")!.getBoundingClientRect().top);
  expect(await fieldHidden()).toBe(true);
  answer();
  await expect(options.first()).not.toHaveAttribute("aria-disabled", "true");
  expect(await fieldHidden()).toBe(true);
  await expect.poll(() => resultsFit(page)).toEqual({ top: true, bottom: true });
  await pageArea.evaluate((el) => el.scrollTo(0, 0));
  await expect.poll(() => resultsFit(page)).toEqual({ top: true, bottom: true });
  await page.keyboard.type("m");
  await expect(options.first()).not.toHaveAttribute("aria-disabled", "true");

  // While the answer to new words is on its way, the old results cannot be opened: Enter takes the new words to the Brain.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  // The page leaves before the held answer is let go, so the request may be gone by then; that is the point.
  await page.route(/\/api\/v1\/memory\/search\?q=Orion/, (route) => held.then(() => route.continue().catch(() => undefined)), { times: 1 });
  await search.fill("Orion");
  await expect(options.first()).toHaveAttribute("aria-disabled", "true");
  await expect(search).not.toHaveAttribute("aria-activedescendant", /./);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${stack.url}/brain?q=Orion`);
  release();

  // Esc from a link in the results closes them and puts the owner back in the field.
  await page.goto(`${stack.url}/`);
  await field(page).fill("Helios");
  await expect(options).toHaveCount(6);
  await page.keyboard.press("Tab");
  await expect(page.locator(".search-home [data-ranking]").getByRole("link", { name: "Settings" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(results(page)).toBeHidden();
  await expect(field(page)).toBeFocused();
  await expect(field(page)).toHaveValue("Helios");

  // Enter that confirms an input method's text stays with the input method.
  await page.keyboard.press("ArrowDown");
  await expect(results(page)).toBeVisible();
  await field(page).evaluate((input) => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
  await expect(page).toHaveURL(`${stack.url}/`);
  await expect(results(page)).toBeVisible();

  // Home and End show the caret where they put it when the words are wider than the field.
  await field(page).fill(`Helios ${"workstream ".repeat(20)}`.trim());
  const scrollLeft = () => field(page).evaluate((input) => ({ at: input.scrollLeft, end: input.scrollWidth - input.clientWidth }));
  await pressAsOnMac(page, "Home");
  expect(await field(page).evaluate((input: HTMLInputElement) => input.selectionStart)).toBe(0);
  expect((await scrollLeft()).at).toBe(0);
  await pressAsOnMac(page, "End");
  expect(await field(page).evaluate((input: HTMLInputElement) => input.selectionStart === input.value.length)).toBe(true);
  const end = await scrollLeft();
  expect(end.end).toBeGreaterThan(0);
  expect(end.at).toBeGreaterThanOrEqual(end.end - 1);
  await page.setViewportSize({ width: 1360, height: 900 });
});

test("keys: Ctrl K, Cmd K and / focus Home's field, and off Home they go to the Brain's search", async () => {
  const page = await journeys.open("/");
  const search = field(page);
  await expect(search).toBeVisible();
  await page.keyboard.press("Control+k");
  await expect(search).toBeFocused();
  await page.locator(".home-head").click();
  await expect(search).not.toBeFocused();
  await page.keyboard.press("Meta+k");
  await expect(search).toBeFocused();
  // Inside the field `/` is a character like any other.
  await page.keyboard.type("a/b");
  await expect(search).toHaveValue("a/b");
  // The shortcut sheet lists them.
  await page.locator(".home-head").click();
  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet.getByRole("table", { name: "Search" })).toContainText("Search the Brain");
  await page.keyboard.press("Escape");

  await page.goto(`${stack.url}/jobs`);
  await expect(page.getByRole("heading", { level: 1, name: "Jobs" })).toBeVisible();
  await page.keyboard.press("/");
  await expect(page).toHaveURL(`${stack.url}/brain`);
  await expect(page.getByRole("searchbox", { name: "Search the Brain" })).toBeFocused();
});

test("browse: one disclosure beside the field opens People, Projects, Decisions, Notes and Recent saves", async () => {
  const page = await journeys.open("/");
  const browse = page.getByRole("button", { name: "Browse" });
  await expect(browse).toHaveAttribute("aria-expanded", "false");
  const links = page.getByRole("list", { name: "Browse the Brain" });
  await expect(links).toBeHidden();
  await browse.click();
  await expect(browse).toHaveAttribute("aria-expanded", "true");
  await expect(links.getByRole("link")).toHaveText(["People", "Projects", "Decisions", "Notes", "Recent saves"]);
  // Esc from a link closes them and returns to the button.
  await links.getByRole("link", { name: "People" }).focus();
  await page.keyboard.press("Escape");
  await expect(links).toBeHidden();
  await expect(browse).toBeFocused();
  await browse.click();
  await links.getByRole("link", { name: "Projects" }).click();
  await expect(page).toHaveURL(`${stack.url}/brain?tab=project`);
  await expect(page.getByRole("tab", { name: "Projects" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".list-item", { hasText: "Helios workstream 1" })).toBeVisible();
});

test("narrow: the prompt fits at 320 and 375 px and at 200% zoom, and the keycap gives way while the shortcut still works", async () => {
  const page = await journeys.open("/");
  // 640 x 400 is a 1280 x 800 window at 200% zoom.
  for (const [width, height, keycap] of [
    [320, 640, false],
    [375, 812, false],
    [640, 400, true],
  ] as const) {
    await page.setViewportSize({ width, height });
    const fit = await promptFits(page);
    expect(fit.text, `"Search the Brain" fits the field at ${width} px`).toBeLessThanOrEqual(fit.room);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `no sideways scroll at ${width} px`).toBe(0);
    await expect(page.locator(".search-home .search-key"), `keycap at ${width} px`).toBeVisible({ visible: keycap });
  }
  await page.setViewportSize({ width: 320, height: 640 });
  await page.locator(".home-head").click();
  await page.keyboard.press("Control+k");
  await expect(field(page)).toBeFocused();
  // A note opened from Home's results shows in view on a phone, below the Brain's own results, even when those
  // results arrive after the note. Chrome's scroll anchoring would hide the problem; Safari does not anchor.
  await page.addStyleTag({ content: ".page { overflow-anchor: none; }" });
  await field(page).fill("Postmark");
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/api\/v1\/memory\/search\?q=Postmark$/, (route) => held.then(() => route.continue()), { times: 1 });
  await results(page).getByRole("option", { name: /Email vendor/ }).click();
  await expect(page).toHaveURL(/\/brain\?root=data&path=/);
  await expect(page.locator('[data-subject="Decision"]')).toBeVisible();
  release();
  await expect(page.locator(".split .list-item").first()).toBeVisible();
  // The note starts at the top of the window, or, when the page ends first, shows in full above the bottom bar.
  const noteInView = () =>
    page.locator(".split-detail").evaluate((note) => {
      const box = note.getBoundingClientRect();
      return box.top <= 80 || box.bottom <= document.querySelector(".bottom-bar")!.getBoundingClientRect().top;
    });
  await expect.poll(noteInView, "the opened note is in view").toBe(true);
  await page.goto(`${stack.url}/`);
  await page.locator(".home-head").click();
  await page.keyboard.press("Control+k");
  // The results stay inside the window.
  await page.keyboard.type("Helios");
  const list = (await results(page).boundingBox())!;
  expect(list.x).toBeGreaterThanOrEqual(0);
  expect(list.x + list.width).toBeLessThanOrEqual(320);
  // A result's wrapped meta line starts with its words, never with a separator dot.
  const metas = results(page).locator(".search-hit-meta");
  await expect(metas).toHaveCount(6);
  for (const meta of await metas.all()) expect(await meta.evaluate(lineStarts)).not.toContain("·");
  await page.setViewportSize({ width: 1360, height: 900 });
});

test("no unresolved console errors across journeys", () => {
  expect(journeys.consoleErrors).toEqual([]);
});
