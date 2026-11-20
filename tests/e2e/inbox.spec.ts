/**
 * Home's typed Inbox (#23 of spec #14): kind stamps and words, the frozen order and Show new items, the type picker,
 * Newest first, Group by type, Hidden, pages of twenty, row keys and the opt-in decision keys, narrow rows, driven
 * through the Dashboard against the real bundled service and the TEST-ONLY fixtures (GitHub, Gmail and a notes folder).
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, JourneyBrowser } from "./browser.ts";
import { inboxRow, inboxView, openRow } from "./inbox.ts";
import { buildAll, startStack, type Stack } from "./stack.ts";

let stack: Stack;
let journeys: JourneyBrowser;
let notesId = "";

test.describe.configure({ mode: "serial" });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
/** More deadlines than one page holds, each due on its own day so the order is known. */
const RELEASE_TASKS = Array.from({ length: 24 }, (_, i) => `Prepare release note ${String(i + 1).padStart(2, "0")}`);
/** A subject long enough to wrap at 360 px, whose last words tell it apart. */
const LONG = "Confirm the recovery rehearsal schedule with the platform team for the Copenhagen region";

/** The release notes, with `moved` due on a later day than the others' pattern. */
function releaseNote(moved: string | null = null): string {
  return `# Release\n\n## Tasks\n${RELEASE_TASKS.map((t, i) => `- [ ] ${t} 📅 ${day(t === moved ? 13 : 3 + (i % 10))}`).join("\n")}\n- [ ] ${LONG} 📅 ${day(2)}\n`;
}

async function refreshNotes(page: Page): Promise<void> {
  await api(page, "POST", `/connections/${notesId}/refresh`);
}

test.beforeAll(async ({ browser }) => {
  buildAll();
  stack = await startStack();
  writeFileSync(join(stack.vaultDir, "Projects/Release.md"), releaseNote());
  journeys = await JourneyBrowser.start(browser, stack.url);
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
  const kinds = async () => new Set((await api<{ items: Array<{ kind: string }> }>(page, "GET", "/attention?state=open")).items.map((i) => i.kind));
  await expect.poll(async () => [...(await kinds())].sort(), { timeout: 60_000 }).toEqual(expect.arrayContaining(["deadline", "pending_reply", "review_request"]));
  await expect.poll(async () => (await api<{ items: unknown[] }>(page, "GET", "/attention?state=open")).items.length, { timeout: 30_000 }).toBeGreaterThan(25);
  notesId = (await api<Array<{ id: string; kind: string }>>(page, "GET", "/connections")).find((c) => c.kind === "vault" && c.id !== "vault-data")!.id;
  await page.close();
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

const rows = (page: Page) => page.locator("#inbox [data-inbox-row]");
const typePicker = (page: Page) => page.locator("#inbox").getByRole("combobox", { name: "Type" });

/** What tells a row's type apart: the word, the glyph's drawing and the word's colour. */
async function typeOf(row: Locator) {
  return row.locator(".inbox-kind").evaluate((kind) => ({
    word: kind.querySelector(".inbox-kind-word")!.textContent,
    glyph: kind.querySelector("svg")!.innerHTML,
    colour: getComputedStyle(kind).color,
    stamp: getComputedStyle(kind.querySelector(".type-icon")!).backgroundColor,
  }));
}

test("rows: kind stamp and word, subject, source line and time; a review request and a pending reply differ in colour, glyph and word, in light, dark and at 360 px", async () => {
  const page = await journeys.open("/");
  const review = inboxRow(page, "Add checkout retry");
  const reply = inboxRow(page, "Contract renewal");
  await expect(review).toContainText("Review request");
  await expect(review.locator(".inbox-source")).toContainText("GitHub · acme/web #42");
  await expect(reply).toContainText("Pending reply");
  await expect(reply.locator(".inbox-source")).toContainText("Gmail · Mia Jensen");
  // The subject is the row's own words, without the verb the kind word already says.
  await expect(review.locator("[data-row-toggle]")).toHaveText("Add checkout retry");
  await expect(review.locator(".inbox-time")).toHaveText(/^\d\d:\d\d$|^Yesterday$|^\d+ \w{3}$/);
  // The kind column is about 185 px, with a 34 px stamp and a 19 px glyph.
  const kind = (await review.locator(".inbox-kind").boundingBox())!;
  expect(Math.round(kind.width)).toBe(185);
  const stamp = (await review.locator(".type-icon").boundingBox())!;
  expect([Math.round(stamp.width), Math.round(stamp.height)]).toEqual([34, 34]);
  expect(Math.round((await review.locator(".type-icon svg").boundingBox())!.width)).toBe(19);
  for (const [where, viewport] of [["desktop", { width: 1280, height: 800 }], ["360 px", { width: 360, height: 780 }]] as const) {
    await page.setViewportSize(viewport);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const [a, b] = [await typeOf(review), await typeOf(reply)];
      expect(a.word, `${where} ${scheme}`).not.toBe(b.word);
      expect(a.glyph, `${where} ${scheme}`).not.toBe(b.glyph);
      expect(a.colour, `${where} ${scheme}`).not.toBe(b.colour);
      expect(a.stamp, `${where} ${scheme}`).not.toBe(b.stamp);
    }
  }
  await page.emulateMedia({ colorScheme: null });
  await page.close();
});

test("row actions: Start working stays open and becomes Continue, then Not started clears progress; Snooze and Done decide in place", async () => {
  const page = await journeys.open("/");
  const row = inboxRow(page, "Add checkout retry");
  await expect(row.getByRole("button", { name: "Start working: Add checkout retry" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Snooze: Add checkout retry" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Done: Add checkout retry" })).toBeVisible();
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(row.getByRole("button", { name: "Start working: Add checkout retry" })).toBeHidden();
  await row.getByRole("button", { name: "Actions: Add checkout retry" }).click();
  await expect(row.getByRole("button", { name: "Start working: Add checkout retry" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Snooze: Add checkout retry" })).toBeVisible();
  await expect(row.getByRole("button", { name: "Done: Add checkout retry" })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });
  await row.getByRole("button", { name: "Start working: Add checkout retry" }).click();
  await expect(row.getByRole("button", { name: "Continue: Add checkout retry" })).toBeVisible();
  await expect(row).toContainText("In progress");
  await page.reload();
  await expect(row).toContainText("In progress");
  await openRow(row);
  await row.getByRole("button", { name: "Not started: Add checkout retry" }).click();
  await expect(row).not.toContainText("In progress");

  await row.getByRole("button", { name: "Snooze: Add checkout retry" }).first().click();
  await expect(row.getByRole("menu", { name: "Snooze: Add checkout retry" })).toBeVisible();
  await row.getByRole("menuitem").first().click();
  await expect(row).toHaveAttribute("data-decided", "snooze");
  await row.getByRole("button", { name: "Undo" }).click();
  await row.getByRole("button", { name: "Done: Add checkout retry" }).first().click();
  await expect(row).toHaveAttribute("data-decided", "done");
  await row.getByRole("button", { name: "Undo" }).click();
  await page.close();
});

test("rows without colour: in grayscale a review request and a pending reply still differ by glyph and word", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.addStyleTag({ content: "html { filter: grayscale(1); }" });
  const review = inboxRow(page, "Add checkout retry").locator(".inbox-kind");
  const reply = inboxRow(page, "Contract renewal").locator(".inbox-kind");
  // The pictures differ even with every colour removed: the stamps are drawn differently, and the words differ.
  const [a, b] = [await review.locator(".type-icon").screenshot(), await reply.locator(".type-icon").screenshot()];
  expect(a.equals(b)).toBe(false);
  await expect(review).toHaveText("Review request");
  await expect(reply).toHaveText("Pending reply");
  await page.locator("#inbox").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/screens/grayscale-home-inbox.png" });
  await page.close();
});

test("order and pages: service priority by default, twenty rows with a range and Load more", async () => {
  const page = await journeys.open("/");
  const total = (await api<{ items: unknown[] }>(page, "GET", "/attention?state=open")).items.length;
  await expect(rows(page)).toHaveCount(20);
  await expect(page.locator("[data-range]")).toHaveText(`1–20 of ${total}`);
  // The overdue deadline (priority 80) comes before the review request, which comes before the release notes.
  const order = await rows(page).locator("[data-row-toggle]").allTextContents();
  expect(order.indexOf("Review rollback runbook")).toBeLessThan(order.indexOf("Add checkout retry"));
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(rows(page)).toHaveCount(total);
  await expect(page.locator("[data-range]")).toHaveText(`All ${total}`);
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  await page.close();
});

test("type picker and views: counts in the options, one type, Newest first, Group by type with three previews and Show all, and Hidden", async () => {
  const page = await journeys.open("/");
  await expect(rows(page).first()).toBeVisible();
  const options = await typePicker(page).locator("option").allTextContents();
  expect(options[0]).toMatch(/^All types \(\d+\)$/);
  expect(options).toEqual(expect.arrayContaining([`Deadline (${RELEASE_TASKS.length + 3})`, "Review request (2)", "Pending reply (1)"]));
  await typePicker(page).selectOption({ label: "Pending reply (1)" });
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page)).toContainText("Contract renewal");
  await typePicker(page).selectOption({ index: 0 });

  // Newest first keeps every type: the same total, newest first seen at the top.
  const total = (await api<{ items: unknown[] }>(page, "GET", "/attention?state=open")).items.length;
  await inboxView(page, "Newest first");
  await expect(page.locator("[data-range]")).toHaveText(`1–20 of ${total}`);

  // Group by type: families in order, three previews each, and Show all.
  await inboxView(page, "Group by type");
  const families = page.locator("#inbox .inbox-family");
  const titles = await families.locator("h3").allTextContents();
  expect(titles.slice(0, 3)).toEqual([`Deadlines ${RELEASE_TASKS.length + 3}`, "Reviews 2", "Replies 1"]);
  const deadlines = families.filter({ has: page.locator("h3", { hasText: "Deadlines" }) });
  await expect(deadlines.locator("[data-inbox-row]")).toHaveCount(3);
  await deadlines.getByRole("button", { name: /^Show all \d+$/ }).click();
  await expect(deadlines.locator("[data-inbox-row]")).toHaveCount(RELEASE_TASKS.length + 3);
  // Show all is part of the place kept for the tab, as after a visit to a Draft.
  await page.reload();
  await expect(deadlines.locator("[data-inbox-row]")).toHaveCount(RELEASE_TASKS.length + 3);
  // No tinted group header and no coloured bar on a row.
  expect(await deadlines.locator("h3").evaluate((h) => getComputedStyle(h).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  expect(await deadlines.locator("[data-inbox-row]").first().evaluate((r) => getComputedStyle(r).borderLeftWidth)).toBe("0px");

  // Hidden lists snoozed and dismissed items, with Reopen.
  await inboxView(page, "Priority order");
  const row = inboxRow(page, "Prepare release note 24");
  await openRow(row);
  await row.getByRole("button", { name: "Dismiss" }).click();
  await expect(row).toHaveAttribute("data-decided", "dismiss");
  await inboxView(page, "Hidden");
  const hidden = inboxRow(page, "Prepare release note 24");
  await expect(hidden).toContainText("Dismissed");
  await openRow(hidden);
  await hidden.getByRole("button", { name: "Reopen" }).click();
  await expect(hidden).toContainText("Back in the Inbox");
  await inboxView(page, "Priority order");
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(inboxRow(page, "Prepare release note 24")).not.toHaveAttribute("data-decided");
  await page.close();
});

test("arrivals: a new item waits behind Show new items, without scrolling the page or closing the open row", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 1280, height: 800 });
  const open = inboxRow(page, "Add checkout retry");
  await openRow(open);
  await open.scrollIntoViewIfNeeded();
  const scroller = page.locator(".page");
  const before = { scroll: await scroller.evaluate((el) => el.scrollTop), top: (await open.boundingBox())!.y, order: await rows(page).locator("[data-row-toggle]").allTextContents() };
  const showNew = page.locator("[data-show-new]");
  // The control's place is kept while nothing waits.
  await expect(showNew).toBeHidden();
  const reserved = (await showNew.evaluate((el) => el.getBoundingClientRect().width)) > 0;
  expect(reserved).toBe(true);
  writeFileSync(join(stack.vaultDir, "Projects/Urgent.md"), `# Urgent\n\n- [ ] Renew the signing certificate due:${day(-1)}\n`);
  await refreshNotes(page);
  await expect(showNew).toHaveText("Show 1 new item", { timeout: 30_000 });
  await expect(page.getByRole("status").filter({ hasText: "1 new item waiting" })).toBeAttached();
  // Nothing moved: same scroll, same place for the open row, same order, the row still open.
  expect(await scroller.evaluate((el) => el.scrollTop)).toBe(before.scroll);
  expect((await open.boundingBox())!.y).toBe(before.top);
  expect(await rows(page).locator("[data-row-toggle]").allTextContents()).toEqual(before.order);
  await expect(open.locator("[data-row-toggle]")).toHaveAttribute("aria-expanded", "true");
  await expect(inboxRow(page, "Renew the signing certificate")).toHaveCount(0);
  await showNew.click();
  // The overdue item takes its place by priority, and the keyboard lands on it.
  const arrived = inboxRow(page, "Renew the signing certificate");
  await expect(arrived).toBeVisible();
  await expect(arrived.locator("[data-row-toggle]")).toBeFocused();
  await expect(showNew).toBeHidden();
  await page.close();
});

test("decided rows: a dismissed item whose evidence changes comes back in its place, marked changed", async () => {
  const page = await journeys.open("/");
  const row = inboxRow(page, "Prepare release note 23");
  await openRow(row);
  await row.getByRole("button", { name: "Dismiss" }).click();
  await expect(row).toHaveAttribute("data-decided", "dismiss");
  // The note moves the task's due date: the service reopens the item, and the receipt gives way to it in place.
  writeFileSync(join(stack.vaultDir, "Projects/Release.md"), releaseNote("Prepare release note 23"));
  await refreshNotes(page);
  await expect(row).not.toHaveAttribute("data-decided", { timeout: 30_000 });
  await expect(row).toContainText("Changed since your decision");
  await expect(row.locator(".inbox-time")).toHaveText(/^Due \d+ \w{3}$/);
  await page.close();
});

/** An open item's id by the end of its title, as the service has it now. */
async function itemId(page: Page, titleEnd: string): Promise<string> {
  const { items } = await api<{ items: Array<{ id: string; title: string }> }>(page, "GET", "/attention?state=open");
  return items.find((i) => i.title.endsWith(titleEnd))!.id;
}

const nextFrame = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

test("decided rows: a refresh that lands while the decision is sent keeps the receipt and its Undo", async () => {
  const page = await journeys.open("/");
  const target = await itemId(page, "Prepare release note 21");
  const other = await itemId(page, "Prepare release note 22");
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  await page.route(`**/api/v1/attention/${target}/decision`, async (route) => {
    await held;
    await route.continue();
  });
  try {
    const row = inboxRow(page, "Prepare release note 21");
    await openRow(row);
    await row.getByRole("button", { name: "Dismiss" }).click();
    // While that decision is on its way, another change makes the Dashboard ask again: the answer still has the row open.
    const refreshed = page.waitForResponse((r) => r.url().includes("/api/v1/attention?state=open") && r.ok());
    await api(page, "POST", `/attention/${other}/decision`, { decision: "dismiss" });
    await refreshed;
    // Home shows that answer (the Inbox and Drafts pair has settled) before the decision is let through.
    await expect(inboxRow(page, "Prepare release note 22")).toHaveCount(0);
    // The decision is still on its way, so the row is still open, as that answer has it.
    await expect(row).not.toHaveAttribute("data-decided");
    const after = page.waitForResponse((r) => r.url().includes("/api/v1/attention?state=open") && r.ok());
    release();
    await expect(row).toHaveAttribute("data-decided", "dismiss");
    // The answer after the decision leaves the item out; the receipt and Undo stay in its place.
    await after;
    await nextFrame(page);
    await expect(row).toHaveAttribute("data-decided", "dismiss");
    await row.getByRole("button", { name: "Undo" }).click();
    await expect(row).not.toHaveAttribute("data-decided");
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await api(page, "POST", `/attention/${other}/decision`, { decision: "reopen" });
    await page.close();
  }
});

test("decided rows: an older answer Home publishes after a failed reload keeps the receipt and its Undo", async () => {
  const page = await journeys.open("/");
  await expect(rows(page).first()).toBeVisible();
  const target = await itemId(page, "Prepare release note 11");
  const other = await itemId(page, "Prepare release note 22");
  const hold = () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    return { held, release };
  };
  const decision = hold();
  const drafts = hold();
  const inbox = "**/api/v1/attention?state=open*";
  await page.route(`**/api/v1/attention/${target}/decision`, async (route) => {
    await decision.held;
    await route.continue();
  });
  try {
    const row = inboxRow(page, "Prepare release note 11");
    await openRow(row);
    await row.getByRole("button", { name: "Dismiss" }).click();
    // Drafts is slow, so the Inbox's next answer (asked before the decision, with the row still open) waits in the pair.
    await page.route("**/api/v1/actions?*", async (route) => {
      await drafts.held;
      await route.continue().catch(() => undefined);
    });
    await expect(inboxRow(page, "Prepare release note 22")).toBeVisible();
    const early = page.waitForResponse((r) => r.url().includes("/api/v1/attention?state=open") && r.ok(), { timeout: 15_000 });
    await api(page, "POST", `/attention/${other}/decision`, { decision: "dismiss" });
    await early;
    // The decision succeeds, and the Inbox reload after it fails.
    await page.route(inbox, (route) => route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "busy" } } }));
    const failed = page.waitForResponse((r) => r.url().includes("/api/v1/attention?state=open") && r.status() === 503, { timeout: 15_000 });
    decision.release();
    await failed;
    // Drafts answers, so Home publishes the pair: the older answer that still has the row, beside the failure.
    drafts.release();
    await expect(page.getByRole("alert").filter({ hasText: "busy" })).toBeVisible();
    // The older answer is published once the other dismissed row has left the list.
    await expect(inboxRow(page, "Prepare release note 22")).toHaveCount(0);
    await nextFrame(page);
    await expect(row).toHaveAttribute("data-decided", "dismiss");
    await expect(row.getByRole("button", { name: "Undo" })).toBeVisible();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await row.getByRole("button", { name: "Undo" }).click();
    await expect(row).not.toHaveAttribute("data-decided");
  } finally {
    decision.release();
    drafts.release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await api(page, "POST", `/attention/${other}/decision`, { decision: "reopen" });
    await page.close();
  }
});

test("arrivals: the first answer is kept even when it is empty, so the first item waits behind Show new items", async () => {
  const page = await journeys.newPage();
  const open = "**/api/v1/attention?state=open*";
  await page.route(open, (route) => route.fulfill({ json: { items: [] } }));
  try {
    const first = page.waitForResponse((r) => r.url().includes("/api/v1/attention?state=open"));
    await page.goto(`${stack.url}/`);
    await first;
    await expect(page.getByRole("heading", { level: 2, name: "Inbox" })).toBeVisible();
    await expect(rows(page)).toHaveCount(0);
    await page.unroute(open);
    // Something changes on the service, so the Dashboard asks again, and the real list answers.
    const id = await itemId(page, "Prepare release note 22");
    await api(page, "POST", `/attention/${id}/decision`, { decision: "dismiss" });
    await api(page, "POST", `/attention/${id}/decision`, { decision: "reopen" });
    const showNew = page.locator("[data-show-new]");
    await expect(showNew).toHaveText(/^Show \d+ new items$/, { timeout: 30_000 });
    await expect(rows(page)).toHaveCount(0);
    await expect(page.getByText("New items arrived. Show new items adds them.")).toBeVisible();
    await showNew.click();
    await expect(rows(page).first()).toBeVisible();
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.close();
  }
});

test("keys: j and k move between rows; Done, Snooze and Dismiss keys are off until switched on in the shortcut sheet", async () => {
  const page = await journeys.open("/");
  await expect(rows(page).first()).toBeVisible();
  const toggles = rows(page).locator("[data-row-toggle]");
  await page.locator("main").focus();
  await page.keyboard.press("j");
  await expect(toggles.nth(0)).toBeFocused();
  await page.keyboard.press("j");
  await expect(toggles.nth(1)).toBeFocused();
  await page.keyboard.press("k");
  await expect(toggles.nth(0)).toBeFocused();
  const first = rows(page).first();
  const subject = await toggles.nth(0).textContent();
  // Off by default: w and d change nothing.
  await page.keyboard.press("w");
  await page.keyboard.press("d");
  await expect(first).not.toHaveAttribute("data-decided");
  await expect(first).not.toContainText("In progress");
  // Enter opens the row in place.
  await page.keyboard.press("Enter");
  await expect(toggles.nth(0)).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Enter");

  // Switch them on in the shortcut sheet.
  await page.keyboard.press("?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet.getByRole("table", { name: "Inbox decisions, off" })).toBeVisible();
  await sheet.getByRole("checkbox", { name: "Use the decision keys" }).check();
  await expect(sheet.getByRole("table", { name: "Inbox decisions, on" })).toBeVisible();
  // Nothing irreversible ever has a single key.
  await expect(sheet).not.toContainText(/\b(Apply|Approve|Send|Reject|Revert|Disconnect)\b/);
  await expect(sheet).toContainText("Start working");
  await page.keyboard.press("Escape");
  await toggles.nth(0).focus();
  await page.keyboard.press("d");
  const decided = page.locator("#inbox [data-inbox-row]", { hasText: subject! });
  await expect(decided).toHaveAttribute("data-decided", "done");
  await expect(decided.getByRole("button", { name: "Undo" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(decided).not.toHaveAttribute("data-decided");

  // Off again, and it stays off after a reload.
  await page.keyboard.press("?");
  await sheet.getByRole("checkbox", { name: "Use the decision keys" }).uncheck();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(rows(page).first()).toBeVisible();
  await page.keyboard.press("?");
  await expect(sheet.getByRole("checkbox", { name: "Use the decision keys" })).not.toBeChecked();
  await page.keyboard.press("Escape");
  await page.close();
});

test("narrow: at 360 px the pickers work, the stamp and kind come first, the whole subject wraps at 16 px or more, and nothing scrolls sideways", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 360, height: 780 });
  await expect(rows(page).first()).toBeVisible();
  await page.locator("#inbox").evaluate((el) => el.scrollIntoView({ block: "start" }));
  await page.screenshot({ path: "test-results/screens/narrow-home-inbox-head.png" });
  // On a narrow window Show new items' place shows the range while nothing waits, at the button's height.
  await expect(page.locator(".inbox-tools-range")).toHaveText(/^1–20 of \d+$/);
  expect(Math.round((await page.locator(".inbox-tools-range").boundingBox())!.height)).toBe(36);
  const deadline = (await typePicker(page).locator("option").allTextContents()).find((o) => o.startsWith("Deadline ("))!;
  await typePicker(page).selectOption({ label: deadline });
  await expect(rows(page).first()).toHaveAttribute("data-type", "deadline");
  await inboxView(page, "Newest first");
  // Group by type keeps Show new items' place too, with the count in it.
  await inboxView(page, "Group by type");
  await expect(page.locator(".inbox-tools-range")).toHaveText(/^\d+ items$/);
  expect(Math.round((await page.locator(".inbox-tools-range").boundingBox())!.height)).toBe(36);
  await inboxView(page, "Priority order");
  const long = inboxRow(page, LONG);
  await long.scrollIntoViewIfNeeded();
  const subject = long.locator("[data-row-toggle]");
  await expect(subject).toHaveText(LONG);
  const shape = await subject.evaluate((el) => ({ size: parseFloat(getComputedStyle(el).fontSize), lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)), clipped: el.scrollWidth > el.clientWidth }));
  expect(shape.size).toBeGreaterThanOrEqual(16);
  expect(shape.lines).toBeGreaterThan(1);
  expect(shape.clipped).toBe(false);
  // Reading order: stamp and kind, then the subject, then source and time.
  const [kind, text, source] = await Promise.all([long.locator(".inbox-kind"), subject, long.locator(".inbox-source")].map(async (l) => (await l.boundingBox())!.y));
  expect(kind).toBeLessThan(text!);
  expect(text).toBeLessThan(source!);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  // The last row and its actions stay above the bottom bar.
  await typePicker(page).selectOption({ index: 0 });
  await page.getByRole("button", { name: "Load more" }).click();
  const last = rows(page).last();
  await openRow(last);
  const action = last.getByRole("button", { name: "Dismiss" });
  await action.scrollIntoViewIfNeeded();
  const bar = (await page.locator(".bottom-bar").boundingBox())!;
  expect((await action.boundingBox())!.y + (await action.boundingBox())!.height).toBeLessThanOrEqual(bar.y);
  await page.screenshot({ path: "test-results/screens/narrow-home-inbox.png", fullPage: false });
  await page.close();
});

test("captures: Home's first viewport, an open row, a decided row and Group by type, in light and dark", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(rows(page).first()).toBeVisible();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.locator(".page").evaluate((el) => el.scrollTo(0, 0));
    await page.screenshot({ path: `test-results/screens/${scheme}-home-inbox-first-viewport.png` });
    const review = inboxRow(page, "Add checkout retry");
    await openRow(review);
    await review.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/screens/${scheme}-home-inbox-open.png` });
    await review.locator("[data-row-toggle]").click();
    const cutover = inboxRow(page, "Send the cutover plan to finance");
    await openRow(cutover);
    await cutover.locator(".inbox-detail").getByRole("button", { name: "Done" }).click();
    await expect(cutover).toHaveAttribute("data-decided", "done");
    await page.locator("#inbox").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/screens/${scheme}-home-inbox-decided.png` });
    await cutover.getByRole("button", { name: "Undo" }).click();
    await expect(cutover).not.toHaveAttribute("data-decided");
    await inboxView(page, "Group by type");
    await page.locator("#inbox").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/screens/${scheme}-home-inbox-grouped.png` });
    await inboxView(page, "Priority order");
  }
  await page.emulateMedia({ colorScheme: null });
  await page.close();
});

test("no unresolved console errors across journeys", () => {
  expect(journeys.consoleErrors).toEqual([]);
});
