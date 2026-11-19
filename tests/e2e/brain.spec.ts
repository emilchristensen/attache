/**
 * The Brain (#29 of spec #14): a full-width search field over Library (collections, a collection's notes and the note
 * reader side by side) and Recent saves, each at its own address. Driven through the Dashboard against the real
 * bundled service and the TEST-ONLY fixtures; set up through the API, so it runs on its own.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, expect, type Locator, type Page } from "@playwright/test";
import { api, JourneyBrowser } from "./browser.ts";
import { buildAll, harnessSave, startStack, type Stack } from "./stack.ts";

let stack: Stack;
let journeys: JourneyBrowser;

test.describe.configure({ mode: "serial" });

const NORA = "memory/people/nora-lind.md";
const ATLAS = "memory/projects/atlas-launch.md";
const HANDOVER = "evidence/captures/2026-11-12-pilot-handover.md";
/** Eight projects share a word, more than the six results Home's field shows. */
const HELIOS = Array.from({ length: 8 }, (_, i) => `Helios workstream ${i + 1}`);
const COLLECTIONS = ["People", "Projects", "Decisions", "Notes", "Imported", "Evidence", "Deliverables"];

/** A person written by hand: facts with every kind of source, one past its Review date, Notes and History. */
const noraNote = (inAMonth: string) => `---
type: person
title: Nora Lind
---
# Nora Lind

## Current State
<!-- One entry per subject, dated. Corrections replace the entry; the old value moves to History. -->
- **Role** (2026-11-12, review ${inAMonth}): Pilot lead for the invoice rollout — source: Pilot handover (capture: ${HANDOVER}#L8-L9, observed 2026-11-12)
- **Team** (2026-10-01): Payments — source: Org chart (connector: https://example.com/org/payments, observed 2026-10-01)
- **Prefers** (2026-01-10, review 2026-02-01): Written updates on Mondays — source: slack
- **Office** (2026-11-01): Copenhagen

## Notes
Met at the pilot kickoff. Prefers **short** written updates.

## History
<!-- Append-only. Never edited. -->
- 2026-09-01: **Role** was "Analyst"  (promoted)
- 2026-10-15: Joined the payments guild (source: Claude Code session in attache)
`;

const handoverCapture = `---
type: capture
title: Pilot handover
---
# Pilot handover

> Line one of the handover.
> Nora Lind leads the pilot for the invoice rollout.
> She owns the go-live checklist.
`;

function write(stack: Stack, rel: string, text: string) {
  const file = join(stack.dataDir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

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
  await harnessSave(stack, HELIOS.map((title, i) => ({ action: "create", type: "project", title, facts: [{ subject: "Status", value: `Helios phase ${i + 1} is on track` }] })), { agent: "claude-code", session: "sess-e2e-helios" });
  await harnessSave(stack, [{ action: "create", type: "project", title: "Atlas launch", facts: [{ subject: "Launch date", value: "14 October" }, { subject: "Owner", value: "Ada" }] }], { agent: "claude-code", session: "sess-e2e-1" });
  await harnessSave(stack, [{ action: "update", path: ATLAS, facts: [{ subject: "Launch date", value: "21 October", reason: "vendor slip" }] }], { agent: "claude-code", session: "sess-e2e-2" });
  await harnessSave(stack, [{ action: "update", path: ATLAS, facts: [{ subject: "Owner", value: "Grace", reason: "handover" }] }], { agent: "codex", session: "thread-e2e-3" });
  await harnessSave(stack, [{ action: "update", path: ATLAS, facts: [{ subject: "Owner", value: "Linus", reason: "second handover" }] }], { agent: "codex", session: "thread-e2e-4" });
  const inAMonth = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  write(stack, HANDOVER, handoverCapture);
  write(stack, NORA, noraNote(inAMonth));
  // Notes written by hand reach the index on the next rebuild.
  await api(page, "POST", "/memory/reindex");
  await expect.poll(async () => (await api<Array<{ relPath: string }>>(page, "GET", "/memory/documents?area=memory&type=person")).some((d) => d.relPath === NORA), { timeout: 30_000 }).toBe(true);
  await page.close();
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

const search = (page: Page) => page.getByRole("searchbox", { name: "Search the Brain" });
const collections = (page: Page) => page.getByRole("navigation", { name: "Collections" });
const reader = (page: Page) => page.locator(".note-reader");
const fact = (page: Page, subject: string) => page.locator(`.fact[data-subject="${subject}"]`);
const box = async (l: Locator) => (await l.boundingBox())!;

test("brain: a full-width search field over Library, whose collections, notes and reader sit side by side, with no counts", async () => {
  const page = await journeys.open("/brain");
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("heading", { level: 1, name: "Brain" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Library" })).toHaveAttribute("aria-selected", "true");

  // The field spans the reading column, as wide as the views under it.
  const field = await box(page.locator(".brain-search .search-box"));
  const view = await box(page.locator(".brain-view"));
  expect(Math.abs(field.width - view.width), "the search field spans the column").toBeLessThanOrEqual(1);
  expect(field.height, "a prominent field").toBeGreaterThanOrEqual(52);

  // Every collection by name only: no count beside any of them.
  await expect(collections(page).getByRole("link")).toHaveText(COLLECTIONS);
  await expect(collections(page).getByRole("link", { name: "People" })).toHaveAttribute("aria-current", "true");
  for (const text of await collections(page).getByRole("link").allTextContents()) expect(text, "a collection without a count").not.toMatch(/\d/);

  // Collections, the list and the reader side by side, in that order.
  await collections(page).getByRole("link", { name: "Projects" }).click();
  await expect(page).toHaveURL(`${stack.url}/brain?tab=project`);
  const atlas = page.getByRole("link", { name: /^Atlas launch/ });
  await atlas.click();
  await expect(page).toHaveURL(`${stack.url}/brain?root=data&path=${encodeURIComponent(ATLAS)}&tab=project`);
  await expect(atlas).toHaveAttribute("aria-current", "true");
  await expect(reader(page).getByRole("heading", { level: 2, name: "Atlas launch" })).toBeVisible();
  const [nav, list, note] = [await box(collections(page)), await box(page.locator(".note-list")), await box(reader(page))];
  expect(nav.x + nav.width, "the list is right of the collections").toBeLessThanOrEqual(list.x);
  expect(list.x + list.width, "the reader is right of the list").toBeLessThanOrEqual(note.x);
  expect(Math.abs(nav.y - note.y), "the three start on one line").toBeLessThanOrEqual(2);
  expect(note.width, "a broad text column for the reader").toBeGreaterThanOrEqual(520);

  // Read-only: nothing to type into but the search field.
  await expect(page.locator(".page textarea, .page input:not([type=search])")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /correct|edit|save/i })).toHaveCount(0);
});

test("brain: search results replace the Library with every result, say how they were ranked, and open a note beside them", async () => {
  const page = await journeys.open("/brain?tab=project");
  await page.setViewportSize({ width: 1280, height: 800 });
  await search(page).fill("Helios");
  await expect(page).toHaveURL(`${stack.url}/brain?tab=project&q=Helios`);
  const results = page.getByRole("region", { name: /results for “Helios”/ });
  await expect(results.getByRole("heading", { name: /^\d+ results/ })).toBeVisible();
  // The whole list, more than the six Home's field shows, in place of the collections and the note list.
  await expect.poll(() => results.locator(".result-item").count()).toBeGreaterThanOrEqual(HELIOS.length);
  await expect(collections(page)).toHaveCount(0);
  await expect(page.locator(".note-list")).toHaveCount(0);
  await expect(results.locator("[data-ranking]")).toContainText(/Ranked by/);

  await results.locator(".result-item", { hasText: "Helios workstream 3" }).first().click();
  await expect(reader(page).getByRole("heading", { level: 2, name: "Helios workstream 3" })).toBeVisible();
  await expect(page).toHaveURL(/[?&]q=Helios/);
  const [list, note] = [await box(results), await box(reader(page))];
  expect(list.x + list.width, "the reader is right of the results").toBeLessThanOrEqual(note.x);

  // Back returns to the results; Clear search returns to the Library, field focused.
  await results.getByRole("button", { name: "Clear search" }).click();
  await expect(collections(page)).toBeVisible();
  await expect(search(page)).toHaveValue("");
  await expect(search(page)).toBeFocused();
  await expect(page).not.toHaveURL(/q=/);

  // Choosing the view shown already keeps the collection and note.
  await collections(page).getByRole("link", { name: "Projects" }).click();
  await page.locator(".note-list-item", { hasText: "Atlas launch" }).click();
  const here = page.url();
  await page.getByRole("tab", { name: "Library" }).click();
  await expect(page).toHaveURL(here);
  // Words typed but not yet searched stay behind when the owner goes to Recent saves straight away.
  await search(page).pressSequentially("He");
  await page.getByRole("tab", { name: "Recent saves" }).click();
  await expect(page).toHaveURL(`${stack.url}/brain/recent`);
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(`${stack.url}/brain/recent`);
  await expect(search(page)).toHaveValue("");
  // Back before the words reach the address takes the owner back, with Forward still there.
  await page.getByRole("tab", { name: "Library" }).click();
  await expect(page).toHaveURL(`${stack.url}/brain`);
  await search(page).pressSequentially("He");
  await page.goBack();
  await expect(page).toHaveURL(`${stack.url}/brain/recent`);
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(`${stack.url}/brain/recent`);
  await expect(search(page)).toHaveValue("");
  await page.goForward();
  await expect(page).toHaveURL(`${stack.url}/brain`);
  await page.goBack();
  // Choosing it again keeps its filter.
  await page.getByRole("navigation", { name: "Show" }).getByRole("link", { name: "Reverted" }).click();
  await page.getByRole("tab", { name: "Recent saves" }).click();
  await expect(page).toHaveURL(`${stack.url}/brain/recent?show=reverted`);
});

test("brain: a note picked far down a long list opens in view beside it, and the list keeps its place", async () => {
  const page = await journeys.open("/brain?tab=project");
  await page.setViewportSize({ width: 1280, height: 560 });
  const last = page.locator(".note-list-item").last();
  await last.scrollIntoViewIfNeeded();
  const title = (await last.locator(".note-list-title").textContent())!;
  await last.click();
  await expect(reader(page).getByRole("heading", { level: 2, name: title })).toBeInViewport();
  await expect(last).toBeInViewport();

  // Pinned beside a long list with the bottom bar showing, the reader ends above the bar.
  await page.setViewportSize({ width: 900, height: 560 });
  await page.goto(`${stack.url}/brain?q=Helios&root=data&path=${encodeURIComponent(NORA)}`);
  await expect(reader(page)).toBeVisible();
  await expect.poll(() => page.locator(".result-item").count()).toBeGreaterThanOrEqual(HELIOS.length);
  await page.locator(".page").evaluate((p) => p.scrollTo(0, 600));
  const bar = await box(page.locator(".bottom-bar"));
  await expect.poll(async () => (await box(page.locator(".library-reader"))).y + (await box(page.locator(".library-reader"))).height, "the reader ends above the bottom bar").toBeLessThanOrEqual(bar.y);
});

test("brain: a fact's source is a button that opens in place with pointer, keyboard and touch", async ({ browser }) => {
  const page = await journeys.open(`/brain?path=${encodeURIComponent(NORA)}`);
  await expect(collections(page).getByRole("link", { name: "People" })).toHaveAttribute("aria-current", "true");
  const role = fact(page, "Role");
  const button = role.getByRole("button", { name: /^Source/ });
  const detail = role.locator("[data-source-detail]");
  await expect(button).toHaveText(/Source\s*Pilot handover/);
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await expect(detail).toBeHidden();

  // Pointer.
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(`Pilot handover (capture: ${HANDOVER}#L8-L9, observed 2026-11-12)`);
  await expect(detail).toContainText("Capture · observed 2026-11-12");
  await button.click();
  await expect(detail).toBeHidden();

  // Keyboard: Enter and Space both toggle it; the cited lines open in the evidence view.
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(detail).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(detail.getByRole("button", { name: "Open lines 8–9" })).toBeFocused();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: /Evidence/ });
  await expect(drawer.locator(".line.hl")).toHaveText([/Nora Lind leads the pilot/, /She owns the go-live checklist/]);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await button.focus();
  await page.keyboard.press("Space");
  await expect(detail).toBeHidden();

  // A web page opens as a link; a hand-written source shows as written, with nothing to open.
  const team = fact(page, "Team");
  await team.getByRole("button", { name: /^Source/ }).click();
  await expect(team.getByRole("link", { name: "Open the page" })).toHaveAttribute("href", "https://example.com/org/payments");
  const prefers = fact(page, "Prefers");
  await prefers.getByRole("button", { name: /^Source/ }).click();
  await expect(prefers.locator("[data-source-detail]")).toHaveText("slack");
  // A fact with no source has no button.
  await expect(fact(page, "Office").getByRole("button")).toHaveCount(0);

  // Touch: a tap opens it, on a touch screen with no hover.
  const touch = await browser.newContext({ storageState: await journeys.context.storageState(), hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  try {
    const phone = await touch.newPage();
    await phone.goto(`${stack.url}/brain?path=${encodeURIComponent(NORA)}`);
    const tapped = fact(phone, "Role").getByRole("button", { name: /^Source/ });
    await tapped.tap();
    await expect(tapped).toHaveAttribute("aria-expanded", "true");
    await expect(fact(phone, "Role").locator("[data-source-detail]")).toBeVisible();
    const size = await box(tapped);
    expect(size.height, "a touch-sized source button").toBeGreaterThanOrEqual(36);
  } finally {
    await touch.close();
  }
});

test("brain: the reader shows Review dates, History as stored, the Change log closed, the identity line and a waiting Proposal", async () => {
  const page = await journeys.open(`/brain?path=${encodeURIComponent(NORA)}`);
  const inAMonth = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await expect(fact(page, "Role")).toContainText(`review after ${inAMonth}`);
  await expect(fact(page, "Role")).not.toContainText("unverified");
  await expect(fact(page, "Prefers")).toContainText("unverified");
  await expect(fact(page, "Prefers")).toContainText("review was due 2026-02-01");
  // Notes as prose, History exactly as the note stores it (double spaces and all), in its order.
  await expect(reader(page).getByRole("region", { name: "Notes" })).toContainText("Met at the pilot kickoff.");
  const history = reader(page).getByRole("region", { name: "History" }).getByRole("listitem");
  const stored = readFileSync(join(stack.dataDir, NORA), "utf8").split("## History")[1]!.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).replace(/\*\*/g, ""));
  expect(await history.evaluateAll((items) => items.map((li) => (li as HTMLElement).innerText))).toEqual(stored);

  // The Markdown file itself is one click away, with line numbers, and not in the page until opened.
  const file = reader(page).locator("details.reader-file");
  await expect(file.locator(".source-view")).toHaveCount(0);
  await file.locator("summary").click();
  await expect(file.locator(".source-view .line").first()).toBeVisible();
  await expect(file.locator(".source-view")).toContainText("Met at the pilot kickoff.");

  // A note with changes from a Harness has a Change log, closed until opened.
  await page.goto(`${stack.url}/brain?path=${encodeURIComponent(ATLAS)}`);
  const log = reader(page).locator("details.reader-change-log");
  await expect(log).not.toHaveAttribute("open", "");
  await expect(log.locator("summary")).toContainText(/Change log\s*\d+ changes/);
  await expect(log.getByText(/was “14 October”/)).toBeHidden();
  await log.locator("summary").click();
  await expect(log.getByText(/was “14 October”/)).toBeVisible();

  // A waiting Proposal for this note links to Approvals.
  const proposal = await api<{ id: string }>(page, "POST", "/memory/proposals", { item: { action: "update", path: ATLAS, facts: [{ subject: "Owner", value: "Mira", reason: "third handover" }] }, reason: "Handover call" });
  const waiting = reader(page).locator("[data-waiting-proposals]");
  await expect(waiting).toContainText("A change to this note waits for your OK.");
  await waiting.getByRole("link", { name: "Review it in Approvals" }).click();
  await expect(page).toHaveURL(new RegExp(`/approvals`));
  await expect(page.locator(`[data-proposal="${proposal.id}"], [data-row-id="${proposal.id}"]`).first()).toBeVisible();
  await api(page, "POST", `/memory/proposals/${proposal.id}/reject`);

  // The identity record says where it changes.
  await page.goto(`${stack.url}/brain?path=${encodeURIComponent("memory/self.md")}`);
  const identity = reader(page).locator("[data-identity]");
  await expect(identity).toHaveText("Your identity. It changes only from Settings.");
  await identity.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(`${stack.url}/settings/identity`);
  await expect(page.getByRole("heading", { level: 2, name: "Identity" })).toBeVisible();
});

test("brain: Recent saves has its own address and filters all, written without review, and reverted", async () => {
  const page = await journeys.open("/brain");
  await page.getByRole("tab", { name: "Recent saves" }).click();
  await expect(page).toHaveURL(`${stack.url}/brain/recent`);
  const filters = page.getByRole("navigation", { name: "Show" });
  await expect(filters.getByRole("link")).toHaveText(["All", "Written without review", "Reverted"]);
  await expect(filters.getByRole("link", { name: "All" })).toHaveAttribute("aria-current", "true");
  const rows = page.locator(".recent-saves .recent-change");
  const launch = rows.filter({ hasText: "21 October" });
  await expect(launch).toContainText("Claude Code, session sess-e2e-2");
  await expect(launch.locator("del")).toHaveText("14 October");

  // Nothing was written without review: the owner confirmed every save.
  await filters.getByRole("link", { name: "Written without review" }).click();
  await expect(page).toHaveURL(`${stack.url}/brain/recent?show=unreviewed`);
  await expect(page.locator(".recent-empty")).toHaveText(/Nothing reached the Brain without review/);

  // Revert one, and Reverted shows it beside the revert that undid it.
  await filters.getByRole("link", { name: "All" }).click();
  await launch.getByRole("button", { name: "Revert" }).click();
  await expect(page.getByText("Reverted. The revert is listed as a change of its own.")).toBeVisible();
  await filters.getByRole("link", { name: "Reverted" }).click();
  await expect(page).toHaveURL(`${stack.url}/brain/recent?show=reverted`);
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText("revert");
  await expect(rows.nth(1)).toContainText("reverted");
  // A change a later one overwrote says why it cannot be reverted.
  await filters.getByRole("link", { name: "All" }).click();
  const grace = rows.filter({ hasText: /→\s*Grace/ });
  await expect(grace.getByRole("button", { name: "Revert" })).toHaveCount(0);
  await expect(grace).toContainText("A later change overwrote “Owner”. Revert that change first.");

  // A row's title opens its note in the Library.
  await rows.filter({ hasText: "Helios workstream 1" }).first().getByRole("link", { name: "Helios workstream 1" }).click();
  await expect(page).toHaveURL(/\/brain\?root=data&path=memory%2Fprojects%2Fhelios-workstream-1\.md&tab=project/);
  await expect(page.getByRole("tab", { name: "Library" })).toHaveAttribute("aria-selected", "true");
  await expect(reader(page).getByRole("heading", { level: 2, name: "Helios workstream 1" })).toBeVisible();
});

test("brain: Rebuild index is in the Brain's menu and in Settings", async () => {
  const page = await journeys.open("/brain");
  await expect(page.getByRole("button", { name: "Rebuild index" })).toHaveCount(0);
  const menuButton = page.getByRole("button", { name: "Brain menu" });
  await menuButton.click();
  await page.getByRole("group", { name: "Brain menu" }).getByRole("button", { name: /Rebuild index/ }).click();
  await expect(page.getByText("Rebuilding the search index. Jobs shows its progress.")).toBeVisible();
  await expect(page.getByRole("group", { name: "Brain menu" })).toHaveCount(0);
  await expect(menuButton).toBeFocused();
  // Escape closes it too.
  await menuButton.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("group", { name: "Brain menu" })).toHaveCount(0);

  // In Settings, under Service health.
  await page.goto(`${stack.url}/settings/service`);
  const card = page.locator("[data-search-index]");
  await card.getByRole("button", { name: "Rebuild index" }).click();
  await expect(page.getByText("Rebuilding the search index. Jobs shows its progress.").first()).toBeVisible();
});

test("brain narrow: the collections are one row of chips and the reader goes below the list", async () => {
  const page = await journeys.open("/brain?tab=project");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${stack.url}/brain?tab=project`);
    const chips = collections(page).getByRole("link");
    await expect(chips.first()).toBeVisible();
    const tops = await chips.evaluateAll((links) => links.map((a) => Math.round(a.getBoundingClientRect().top)));
    expect(new Set(tops).size, `the collections are one row at ${width}px`).toBe(1);
    const nav = await box(collections(page));
    const list = await box(page.locator(".note-list"));
    expect(nav.y + nav.height, `the chips sit above the list at ${width}px`).toBeLessThanOrEqual(list.y);
    // The chips that do not fit are a sideways scroll away; the page itself never scrolls sideways.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `no horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
    await collections(page).getByRole("link", { name: "Deliverables" }).scrollIntoViewIfNeeded();
    await expect(collections(page).getByRole("link", { name: "Deliverables" })).toBeInViewport();
    // Picking a note brings the reader, below the list, into view.
    await page.locator(".note-list").getByRole("link", { name: /^Atlas launch/ }).click();
    await expect(reader(page).getByRole("heading", { level: 2, name: "Atlas launch" })).toBeInViewport();
    const [listNow, note] = [await box(page.locator(".note-list")), await box(reader(page))];
    expect(note.y, `the reader is below the list at ${width}px`).toBeGreaterThanOrEqual(listNow.y + listNow.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `no horizontal overflow with a note at ${width}px`).toBeLessThanOrEqual(0);
  }
});

test("brain captures: Library with a note and an open source, every result, Recent saves and the menu, light, dark and narrow", async () => {
  const page = await journeys.open("/brain");
  const shots = "test-results/screens";
  const settle = () => page.waitForTimeout(400);
  for (const [scheme, viewport] of [["light", { width: 1280, height: 800 }], ["dark", { width: 1280, height: 800 }], ["narrow", { width: 390, height: 844 }]] as const) {
    await page.emulateMedia({ colorScheme: scheme === "dark" ? "dark" : "light" });
    await page.setViewportSize(viewport);
    await page.goto(`${stack.url}/brain?path=${encodeURIComponent(NORA)}`);
    await fact(page, "Role").getByRole("button", { name: /^Source/ }).click();
    await settle();
    await page.screenshot({ path: `${shots}/${scheme}-brain-library.png` });
    // The whole note, in a window tall enough to hold it.
    await page.setViewportSize({ width: viewport.width, height: 1600 });
    await reader(page).screenshot({ path: `${shots}/${scheme}-brain-reader.png` });
    await page.setViewportSize(viewport);
    await page.goto(`${stack.url}/brain?q=Helios`);
    await expect(page.locator(".result-item").first()).toBeVisible();
    await settle();
    await page.screenshot({ path: `${shots}/${scheme}-brain-results.png` });
    await page.goto(`${stack.url}/brain/recent`);
    await expect(page.locator(".recent-saves .recent-change").first()).toBeVisible();
    await settle();
    await page.screenshot({ path: `${shots}/${scheme}-brain-recent.png` });
    await page.getByRole("button", { name: "Brain menu" }).click();
    await settle();
    await page.screenshot({ path: `${shots}/${scheme}-brain-menu.png` });
    await page.keyboard.press("Escape");
  }
  expect(journeys.consoleErrors).toEqual([]);
});
