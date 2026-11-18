/**
 * Narrow Inbox titles (#39 of spec #14): on a phone the owner tells apart deadlines whose titles differ only in their
 * last words. Home's Inbox on the heavy day (the deadlines of the shared `heavy-day-v1` fixture, beside GitHub and
 * Gmail rows), driven through the Dashboard against the real bundled service and the TEST-ONLY fixtures at 375 and
 * 320 px. What the owner can read is measured from the drawn words and the pixels, never from the accessible name alone.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, JourneyBrowser } from "./browser.ts";
import { inboxRow, openRow } from "./inbox.ts";
import { phraseShown, placeholderFit } from "./layout.ts";
import { buildAll, ROOT, startStack, type Stack } from "./stack.ts";

let stack: Stack;
let journeys: JourneyBrowser;

test.describe.configure({ mode: "serial" });

interface FixtureRow {
  id: string;
  group: string;
  title: string;
}

/** The heavy day's eight deadlines, as the design's shared fixture writes them: one opening, a region at the end. */
const DEADLINES = (JSON.parse(readFileSync(join(ROOT, "docs/design/dashboard-redesign/astra/dense-fixture.json"), "utf8")) as { rows: FixtureRow[] }).rows.filter((r) => r.group === "Deadlines").map((r) => r.title);
const REHEARSAL = "Finish recovery rehearsal and document rollback ownership: Orion customer migration";
/** The three that come first: due today, so above the later regions. */
const FIRST_THREE = [1, 2, 3].map((n) => `region ${n}`);

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
/** Each region's note: a long title, so the source line runs onto a second line on a phone too. */
const noteTitle = (n: number) => `Orion regional migration ${n}: recovery rehearsal and rollback owners`;
const notePath = (n: number) => `Orion/orion-regional-migration-${n}.md`;

test.beforeAll(async ({ browser }) => {
  buildAll();
  stack = await startStack();
  mkdirSync(join(stack.vaultDir, "Orion"), { recursive: true });
  DEADLINES.forEach((title, i) => {
    const n = i + 1;
    writeFileSync(join(stack.vaultDir, notePath(n)), `---\ntitle: '${noteTitle(n)}'\n---\n# ${noteTitle(n)}\n\n## Tasks\n- [ ] ${title} 📅 ${day(n <= 3 ? 0 : n)}\n`);
  });
  // The service dates deadlines in UTC; a browser in UTC too says "Due today" for them at any hour of the run.
  journeys = await JourneyBrowser.start(browser, stack.url, { timezoneId: "UTC" });
  const page = await journeys.newPage();
  await page.goto(stack.pairUrl());
  await expect(page.getByRole("heading", { name: "Where should Attache keep your knowledge?" })).toBeVisible();
  await api(page, "POST", "/setup/data-folder", { path: stack.dataDir });
  await api(page, "POST", "/setup/identity", { name: "Test User", email: "alex@example.com", confirm: true });
  await api(page, "POST", "/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${stack.fixtureUrl}/model`, model: "fixture-model" } });
  await api(page, "POST", "/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678" } });
  await api(page, "POST", "/connections/gmail/configure", { method: "claude-ai", fields: {} });
  await api(page, "POST", "/setup/complete");
  await api(page, "POST", "/import", { path: stack.vaultDir });
  await api(page, "POST", "/connections/github/refresh");
  await api(page, "POST", "/connections/gmail/refresh");
  const open = () => api<{ items: Array<{ kind: string; title: string }> }>(page, "GET", "/attention?state=open");
  await expect.poll(async () => (await open()).items.filter((i) => i.title.includes(REHEARSAL)).length, { timeout: 60_000 }).toBe(DEADLINES.length);
  await expect.poll(async () => [...new Set((await open()).items.map((i) => i.kind))].sort(), { timeout: 60_000 }).toEqual(expect.arrayContaining(["deadline", "pending_reply", "review_request"]));
  await page.close();
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

const rows = (page: Page) => page.locator("#inbox [data-inbox-row]");
/** The collapsed row of the rehearsal deadline for one region; "region 1" must not also find "region 10". */
const rehearsal = (page: Page, region: string) => rows(page).filter({ has: page.locator("[data-row-toggle]", { hasText: new RegExp(`${REHEARSAL}, ${region}$`) }) });

/** Scrolls the row's subject to the middle of the page, so the window never clips it. */
async function centre(row: Locator): Promise<void> {
  await row.locator("[data-row-toggle]").evaluate((el) => el.scrollIntoView({ block: "center" }));
}

/** The words the owner reads in a collapsed row: the whole subject, its distinguishing end drawn, at 16 px or more. */
async function expectRegionShown(row: Locator, region: string, where: string): Promise<void> {
  const subject = row.locator("[data-row-toggle]");
  await expect(subject, where).toHaveAttribute("aria-expanded", "false");
  await centre(row);
  const shown = await subject.evaluate(phraseShown, region);
  expect(shown, `${region} is drawn in its collapsed row (${where})`).toEqual({ found: true, inside: true, painted: true, fontSize: expect.any(Number) });
  expect(shown.fontSize, where).toBeGreaterThanOrEqual(16);
}

test("heavy day at 375 px: the first three recovery rehearsal deadlines show their region in the collapsed rows, and the search prompt fits, in light and dark", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(rows(page).first()).toBeVisible();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const fit = await page.getByRole("combobox", { name: "Search the Brain" }).evaluate(placeholderFit);
    expect(fit.text, `"Search the Brain" fits the field at 375 px (${scheme})`).toBeLessThanOrEqual(fit.room);
    for (const region of FIRST_THREE) await expectRegionShown(rehearsal(page, region), region, `375 px ${scheme}`);
    // The pixels too: three titles that differ only at the end would look the same if the end were cut off.
    const pictures = [];
    for (const region of FIRST_THREE) {
      const subject = rehearsal(page, region).locator("[data-row-toggle]");
      await centre(rehearsal(page, region));
      pictures.push(await subject.screenshot());
    }
    expect(pictures[0]!.equals(pictures[1]!), `region 1 and region 2 look different (${scheme})`).toBe(false);
    expect(pictures[1]!.equals(pictures[2]!), `region 2 and region 3 look different (${scheme})`).toBe(false);
    await rehearsal(page, "region 1").evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: `test-results/screens/narrow-${scheme}-home-inbox-heavy.png` });
  }
  await page.emulateMedia({ colorScheme: null });
  await page.close();
});

test("narrow mixed index: stamp and kind first, the whole subject wrapping at 16 px next, then source and due time, even when the source runs onto two lines", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(rows(page).first()).toBeVisible();
  for (const row of [rehearsal(page, "region 2"), inboxRow(page, "Add checkout retry"), inboxRow(page, "Contract renewal")]) {
    await centre(row);
    const box = async (sel: string) => (await row.locator(sel).boundingBox())!;
    const [kind, subject, source, time] = [await box(".inbox-kind"), await box("[data-row-toggle]"), await box(".inbox-source"), await box(".inbox-time")];
    expect(kind.y + kind.height).toBeLessThanOrEqual(subject.y + 0.5);
    expect(subject.y + subject.height).toBeLessThanOrEqual(source.y + 0.5);
    expect(time.y).toBeGreaterThanOrEqual(subject.y + subject.height - 0.5);
    expect(time.x).toBeGreaterThanOrEqual(source.x + source.width - 0.5);
  }
  // The rehearsal's subject wraps whole, and its long note title runs onto a second source line beside the due time.
  const row = rehearsal(page, "region 2");
  const subject = row.locator("[data-row-toggle]");
  await centre(row);
  await expect(subject).toHaveText(`${REHEARSAL}, region 2`);
  const lines = (el: Element) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
  expect(await subject.evaluate(lines)).toBeGreaterThan(1);
  expect(await row.locator(".inbox-source").evaluate(lines)).toBeGreaterThan(1);
  expect(await row.locator(".inbox-source").evaluate(phraseShown, noteTitle(2))).toMatchObject({ found: true, inside: true, painted: true });
  await expect(row.locator(".inbox-time")).toHaveText("Due today");
  await rows(page).first().evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: "test-results/screens/narrow-home-inbox-mixed.png" });
  await page.close();
});

test("320 px: type, source and due time stay legible on every row, and only the page scrolls", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 320, height: 640 });
  await expect(rows(page).first()).toBeVisible();
  // Only the page scrolls: the window itself moves neither sideways nor down, so the masthead and the bottom bar stay put.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight - innerHeight), "the window does not scroll down").toBeLessThanOrEqual(0);
  for (const row of await rows(page).all()) {
    await centre(row);
    const text = await row.evaluate((el) => ({
      kind: el.querySelector(".inbox-kind-word")!.textContent!,
      source: el.querySelector(".inbox-source > span:not(.sr-only)")!.textContent!,
      time: el.querySelector(".inbox-time")!.textContent!,
    }));
    for (const [part, sel] of [["kind", ".inbox-kind"], ["source", ".inbox-source"], ["time", ".inbox-time"]] as const) {
      const shown = await row.locator(sel).evaluate(phraseShown, text[part]);
      expect(shown, `${part} "${text[part]}" is drawn whole at 320 px`).toMatchObject({ found: true, inside: true, painted: true });
      expect(shown.fontSize).toBeGreaterThanOrEqual(13);
    }
    expect(await row.locator("[data-row-toggle]").evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  }
  await expectRegionShown(rehearsal(page, "region 2"), "region 2", "320 px");
  await rehearsal(page, "region 1").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: "test-results/screens/narrow-320-home-inbox-heavy.png" });
  await page.close();
});

test("journey: on a phone the owner picks region 2 by its visible title, opens that row and sees its own note", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(rows(page).first()).toBeVisible();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // Find region 2 the way the owner does: among the rehearsal rows, the one whose drawn title ends with it.
    const candidates = page.locator("#inbox [data-inbox-row]", { hasText: REHEARSAL });
    let picked: Locator | null = null;
    for (const row of await candidates.all()) {
      if ((await row.locator("[data-row-toggle]").getAttribute("aria-expanded")) !== "false") continue;
      await centre(row);
      const shown = await row.locator("[data-row-toggle]").evaluate(phraseShown, "region 2");
      if (shown.found && shown.inside && shown.painted) picked = row;
    }
    expect(picked, "one collapsed row shows region 2").not.toBeNull();
    await openRow(picked!);
    const detail = picked!.locator(".inbox-detail");
    await expect(detail).toBeVisible();
    await expect(picked!.locator("[data-row-toggle]")).toHaveText(`${REHEARSAL}, region 2`);
    await expect(picked!.locator(".inbox-source")).toContainText(`Notes · ${noteTitle(2)}`);
    await expect(detail.locator(".inbox-summary")).toContainText(`From “${noteTitle(2)}” (${notePath(2)}`);
    await expect(detail.locator(".inbox-summary")).toContainText(`due ${day(0)}`);
    await picked!.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.screenshot({ path: `test-results/screens/narrow-${scheme}-home-inbox-region-2-open.png` });
    // Closed again, the other regions are still told apart.
    await picked!.locator("[data-row-toggle]").click();
    await expect(picked!.locator("[data-row-toggle]")).toHaveAttribute("aria-expanded", "false");
  }
  await page.emulateMedia({ colorScheme: null });
  await page.close();
});

test("no unresolved console errors across journeys", () => {
  expect(journeys.consoleErrors).toEqual([]);
});
