/**
 * Home's Inbox says exactly what it knows (#24 of spec #14): each empty state from its fixture (the open Inbox, the
 * count route and the Connections it read), a failed request on first load and after a good load, the count line
 * relating rows to decisions, the open row and its place kept across a visit to a Draft, and Recently added as one
 * line that is absent while Saving to memory is off. Driven through the Dashboard against the real bundled service;
 * where a state needs answers the stack cannot give on demand, the answer is routed, as the visual captures do.
 */
import { test, expect, type Page, type Route } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttentionItemView, DecisionTotals } from "@attache/contracts";
import { api, JourneyBrowser } from "./browser.ts";
import { inboxRow, openRow } from "./inbox.ts";
import { routeSignIn } from "./home-fold.ts";
import { buildAll, startStack, type Stack } from "./stack.ts";

let stack: Stack;
let journeys: JourneyBrowser;

test.describe.configure({ mode: "serial" });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
/** Enough deadlines that the Inbox scrolls. */
const TASKS = Array.from({ length: 16 }, (_, i) => `Check rollout step ${String(i + 1).padStart(2, "0")}`);

test.beforeAll(async ({ browser }) => {
  buildAll();
  stack = await startStack();
  writeFileSync(join(stack.vaultDir, "Projects/Rollout.md"), `# Rollout\n\n## Tasks\n${TASKS.map((t, i) => `- [ ] ${t} 📅 ${day(2 + i)}`).join("\n")}\n`);
  journeys = await JourneyBrowser.start(browser, stack.url);
  const page = await journeys.newPage();
  await page.goto(stack.pairUrl());
  await expect(page.getByRole("heading", { name: "Where should Attache keep your knowledge?" })).toBeVisible();
  await api(page, "POST", "/setup/data-folder", { path: stack.dataDir });
  await api(page, "POST", "/setup/identity", { name: "Test User", email: "alex@example.com", confirm: true });
  await api(page, "POST", "/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${stack.fixtureUrl}/model`, model: "fixture-model" } });
  await api(page, "POST", "/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678" } });
  // A Harness too, so every feature is ready and Home's Connections area can be the one green line.
  await api(page, "POST", "/connections/claude-code/configure", { method: "hooks", fields: {} });
  await api(page, "POST", "/setup/complete");
  await api(page, "POST", "/import", { path: stack.vaultDir });
  // One full Source refresh, so every source has a stored read: only then may Home say every source was read.
  await api(page, "POST", "/jobs", { kind: "source-refresh", input: { all: true } });
  await expect.poll(async () => (await api<{ lastRefreshAt: string | null }>(page, "GET", "/reader")).lastRefreshAt, { timeout: 60_000 }).not.toBeNull();
  await expect.poll(async () => (await api<{ items: unknown[] }>(page, "GET", "/attention?state=open")).items.length, { timeout: 30_000 }).toBeGreaterThan(TASKS.length);
  await page.close();
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

const inbox = (page: Page) => page.locator("#inbox");
const emptyState = (page: Page) => page.locator("#inbox [data-inbox-empty]");
const failure = (page: Page) => page.locator("#inbox [data-group-failure]");
const rows = (page: Page) => page.locator("#inbox [data-inbox-row]");
const connectionsArea = (page: Page) => page.getByRole("status", { name: "Connections" });

/** The open Inbox list as the shell asks for it (`/attention?state=open&limit=200`), not Hidden's request. */
const isOpenList = (url: URL) => url.pathname === "/api/v1/attention" && url.searchParams.get("state") === "open";
const isCount = (url: URL) => url.pathname === "/api/v1/decision-count";

/** Answers the open Inbox with `items` (by default none). */
async function routeOpen(page: Page, change: (items: AttentionItemView[]) => AttentionItemView[] = () => []) {
  await page.route(isOpenList, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { items: AttentionItemView[] };
    await route.fulfill({ response: res, json: { ...body, items: change(body.items) } });
  });
}

/** Answers the count route with `totals`, or with a failure while `fails()` says so. */
async function routeCount(page: Page, totals: DecisionTotals, fails: () => boolean = () => false) {
  await page.route(isCount, (route: Route) => (fails() ? route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "The count is unavailable" } } }) : route.fulfill({ json: totals })));
}

const NONE: DecisionTotals = { inbox: 0, drafts: 0, proposals: 0, signIns: 0 };
const clock = /\d{2}:\d{2}/;

test("empty: Nothing needs you. only from an exact zero with every source read, beside the logo without its dot, saying what was read", async () => {
  const page = await journeys.newPage();
  await routeOpen(page);
  await routeCount(page, NONE);
  await page.goto(stack.url);
  await expect(connectionsArea(page)).toHaveAttribute("data-connections", "all_good");
  const empty = emptyState(page);
  await expect(empty).toHaveAttribute("data-inbox-empty", "clear");
  await expect(empty.locator(".inbox-empty-title")).toHaveText("Nothing needs you.");
  await expect(empty.locator(".inbox-empty-line")).toHaveText([new RegExp(`^All \\d+ sources were read, last at ${clock.source}\\.$`)]);
  await expect(empty.locator(".logo")).toBeVisible();
  await expect(empty.locator(".logo-dot")).toHaveCount(0);
  await expect(page.locator(".masthead .brand .logo-dot")).toHaveCount(0);
  // Nothing to relate, no failure, no type picker counting nothing.
  await expect(page.locator(".count-line")).toHaveCount(0);
  await expect(failure(page)).toHaveCount(0);
  await expect(page.locator("[data-need-you]")).toHaveCount(0);
  await page.close();
});

test("empty: a source not read says what was found where, which source was not read, and the sign-in that waits", async () => {
  const page = await journeys.newPage();
  await routeOpen(page);
  await routeCount(page, { ...NONE, signIns: 1 });
  await routeSignIn(page);
  await page.goto(stack.url);
  const empty = emptyState(page);
  await expect(empty).toHaveAttribute("data-inbox-empty", "open");
  await expect(empty.locator(".inbox-empty-title")).toHaveText(/^Nothing found in the (\d+ sources|one source) that (were|was) read\.$/);
  await expect(empty.locator(".inbox-empty-line")).toHaveText(["Not read: GitHub (sign-in needed).", "A Connection needs your sign-in, above."]);
  await expect(empty.locator(".logo")).toHaveCount(0);
  await page.close();
});

test("empty: with only the notes read, the Inbox never says all work is clear", async () => {
  const page = await journeys.newPage();
  await routeOpen(page);
  await routeCount(page, NONE);
  await page.route("**/api/v1/capabilities", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { connections: Array<{ kind: string }> };
    await route.fulfill({ response: res, json: { ...body, connections: body.connections.filter((c) => c.kind !== "github") } });
  });
  await page.goto(stack.url);
  const empty = emptyState(page);
  await expect(empty.locator(".inbox-empty-title")).toHaveText("Nothing found in your notes.");
  await expect(empty.locator(".inbox-empty-line")).toHaveText(["No work source is connected, so only your notes were read."]);
  await expect(empty.locator(".logo")).toHaveCount(0);
  await page.close();
});

test("empty: with approvals waiting the Inbox says it has no open items and where the decisions are", async () => {
  const page = await journeys.newPage();
  await routeOpen(page);
  await routeCount(page, { ...NONE, drafts: 2, proposals: 1 });
  await page.goto(stack.url);
  const empty = emptyState(page);
  await expect(empty.locator(".inbox-empty-title")).toHaveText("No open Inbox items.");
  await expect(empty.locator(".inbox-empty-line")).toHaveText([/^All \d+ sources were read/, "3 approvals wait on their own page."]);
  await empty.getByRole("link", { name: "3 approvals wait on their own page." }).click();
  await expect(page).toHaveURL(`${stack.url}/approvals`);
  await page.close();
});

test("empty: when approvals could not be counted the Inbox makes no claim, and Retry asks again", async () => {
  const page = await journeys.newPage();
  let fails = true;
  await routeOpen(page);
  await routeCount(page, NONE, () => fails);
  // The count falls back to the lists; the Drafts list fails too, so the Approvals part is not known.
  await page.route("**/api/v1/actions?status=draft,approved,revoked*", (route) => (fails ? route.abort() : route.continue()));
  await page.goto(stack.url);
  const empty = emptyState(page);
  await expect(empty.locator(".inbox-empty-title")).toHaveText("No open Inbox items.");
  await expect(empty.locator(".inbox-empty-line").last()).toHaveText("Approvals could not be counted, so Attache cannot say that nothing needs you.");
  await expect(empty.locator(".logo")).toHaveCount(0);
  fails = false;
  await empty.getByRole("button", { name: "Retry" }).click();
  await expect(empty.locator(".inbox-empty-title")).toHaveText("Nothing needs you.");
  await page.close();
});

test("empty: Retry asks again only for what failed, never the Inbox that answered", async () => {
  const page = await journeys.newPage();
  let fails = true;
  await routeOpen(page);
  await routeCount(page, NONE, () => fails);
  // The count falls back to the lists; the Proposals list fails, the Inbox and Drafts answer.
  await page.route("**/api/v1/memory/proposals?*", (route) => (fails ? route.abort() : route.continue()));
  await page.goto(stack.url);
  const empty = emptyState(page);
  await expect(empty.locator(".inbox-empty-line").last()).toHaveText("Approvals could not be counted, so Attache cannot say that nothing needs you.");
  const asked: string[] = [];
  page.on("request", (r) => asked.push(new URL(r.url()).pathname));
  fails = false;
  await empty.getByRole("button", { name: "Retry" }).click();
  await expect(empty.locator(".inbox-empty-title")).toHaveText("Nothing needs you.");
  expect(asked).toContain("/api/v1/memory/proposals");
  expect(asked).toContain("/api/v1/decision-count");
  expect(asked).not.toContain("/api/v1/attention");
  expect(asked).not.toContain("/api/v1/actions");
  await page.close();
});

test("loading: until the feature switches answer, the Inbox loads and never says it is switched off", async () => {
  const page = await journeys.newPage();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  // The app's own first answer lets the shell in; the ones after it (Home's among them) wait.
  let asked = 0;
  await page.route("**/api/v1/config", async (route) => {
    if (++asked > 1) await held;
    await route.continue();
  });
  await page.goto(stack.url);
  await expect(inbox(page).getByRole("status", { name: "Loading the Inbox" })).toBeVisible();
  await expect(inbox(page)).not.toContainText("switched off");
  await expect(inbox(page)).not.toContainText("is off");
  release();
  await expect(rows(page).first()).toBeVisible();
  await page.close();
});

test("failed: on first load the Inbox shows the failure with Retry in the rows' place, never an empty list", async () => {
  const page = await journeys.newPage();
  let fails = true;
  await page.route(isOpenList, (route) => (fails ? route.fulfill({ status: 500, json: { error: { code: "internal", message: "The Inbox store is locked" } } }) : route.continue()));
  await page.goto(stack.url);
  await expect(failure(page)).toContainText("The Inbox could not be loaded. This is not an empty list: Attache does not know what is here. The Inbox store is locked");
  await expect(emptyState(page)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(0);
  await expect(inbox(page).getByRole("combobox", { name: "Type" })).toHaveCount(0);
  await expect(page.locator(".count-line")).toHaveCount(0);
  // The count route still answers, and the total stays on the tab; beside a failed list the heading claims nothing.
  await expect(page).toHaveTitle(/^\(\d+\) Attache$/);
  await expect(page.locator("[data-need-you]")).toHaveCount(0);
  fails = false;
  await failure(page).getByRole("button", { name: "Retry" }).click();
  await expect(rows(page).first()).toBeVisible();
  await expect(failure(page)).toHaveCount(0);
  await expect(inbox(page).getByRole("combobox", { name: "Type" })).toBeVisible();
  await expect(page.locator("[data-need-you]")).toBeVisible();
  await page.close();
});

test("failed: after a good load the Inbox keeps its rows, says how old they are, and Retry brings it up to date", async () => {
  const page = await journeys.newPage();
  await page.goto(stack.url);
  const step = inboxRow(page, TASKS[0]!);
  await expect(step).toBeVisible();
  const shown = await rows(page).count();
  const item = (await api<{ items: AttentionItemView[] }>(page, "GET", "/attention?state=open")).items.find((i) => i.title.includes(TASKS[0]!))!;
  let fails = true;
  await page.route(isOpenList, (route) => (fails ? route.abort() : route.continue()));
  // Something changes in the Inbox elsewhere; asking again fails.
  await api(page, "POST", `/attention/${item.id}/decision`, { decision: "dismiss" });
  await expect(failure(page)).toContainText(new RegExp(`The Inbox could not be refreshed\\. These are the rows from ${clock.source}\\. They may have changed\\.`));
  await expect(rows(page)).toHaveCount(shown);
  await expect(step).toBeVisible();
  await expect(emptyState(page)).toHaveCount(0);
  await expect(page.locator(".count-line")).toHaveCount(0);
  await expect(page.locator("[data-need-you]")).toHaveCount(0);
  fails = false;
  await failure(page).getByRole("button", { name: "Retry" }).click();
  await expect(failure(page)).toHaveCount(0);
  await expect(step).toHaveCount(0);
  await api(page, "POST", `/attention/${item.id}/decision`, { decision: "reopen" });
  await page.close();
});

/** The open Inbox with its first row's Draft waiting in Approvals, and the count route agreeing. */
async function routeDraftWaiting(page: Page): Promise<string> {
  const open = (await api<{ items: AttentionItemView[] }>(page, "GET", "/attention?state=open")).items;
  const target = open.find((i) => i.title.includes(TASKS[9]!))!;
  await routeOpen(page, (items) => items.map((i) => (i.id === target.id ? { ...i, actionId: "draft-fixture", actionStatus: "draft" } : i)));
  await routeCount(page, { ...NONE, inbox: open.length - 1, drafts: 1 });
  return TASKS[9]!;
}

test("count line: relates the rows to the decisions when a Draft waits, and is absent when every row is a decision here", async () => {
  const page = await journeys.open("/");
  await expect(rows(page).first()).toBeVisible();
  await expect(page.locator(".count-line")).toHaveCount(0);
  const total = (await api<{ items: unknown[] }>(page, "GET", "/attention?state=open")).items.length;
  await routeDraftWaiting(page);
  await page.reload();
  await expect(page.locator("[data-need-you]")).toHaveText(`${total - 1} need you here`);
  await expect(page.locator(".count-line")).toHaveText(`${total - 1} items below need you · 1 Draft in Approvals`);
  await page.close();
});

test("a Draft visit: coming back finds the same row open, where it stood on screen", async () => {
  const page = await journeys.newPage();
  await page.goto(stack.url);
  await expect(rows(page).first()).toBeVisible();
  const subject = await routeDraftWaiting(page);
  await page.reload();
  const row = inboxRow(page, subject);
  await openRow(row);
  // Read down the Inbox until the row stands in the middle of the window.
  await row.evaluate((el) => {
    const scroller = el.closest(".page")!;
    scroller.scrollTop += el.getBoundingClientRect().top - window.innerHeight / 2;
  });
  const before = (await row.boundingBox())!.y;
  await row.getByRole("button", { name: "View draft" }).click();
  await expect(page).toHaveURL(`${stack.url}/approvals/draft-fixture`);
  await page.goBack();
  await expect(row.locator("[data-row-toggle]")).toHaveAttribute("aria-expanded", "true");
  await expect.poll(async () => Math.round((await row.boundingBox())!.y)).toBe(Math.round(before));
  // The place is the owner's again as soon as they scroll.
  await page.mouse.move(640, 450);
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await row.boundingBox())!.y).toBeGreaterThan(before);
  await page.close();
});

test("a Draft visit: the row comes back even when new items moved it past the shown rows", async () => {
  const page = await journeys.newPage();
  await page.goto(stack.url);
  await expect(rows(page).first()).toBeVisible();
  const open = (await api<{ items: AttentionItemView[] }>(page, "GET", "/attention?state=open")).items;
  const target = open.find((i) => i.title.includes(TASKS[9]!))!;
  // The latest step the Inbox holds (deadlines further out are not raised yet) ranks below the row.
  const last = TASKS.slice(10).flatMap((t) => open.filter((i) => i.title.includes(t))).at(-1)!;
  // Items that rank above every other, as many as it takes to put the row last of the first twenty.
  let ahead = 0;
  const first = (i: number): AttentionItemView => ({ ...target, id: `ahead-${i}`, key: `ahead-${i}`, title: `Urgent handover ${i}`, priority: 1000, actionId: null, actionStatus: null });
  await routeOpen(page, (items) => [...Array.from({ length: ahead }, (_, i) => first(i)), ...items.map((i) => (i.id === target.id ? { ...i, actionId: "draft-fixture", actionStatus: "draft" as const } : i))]);
  await page.reload();
  const row = inboxRow(page, TASKS[9]!);
  await expect(row).toBeVisible();
  ahead = 19 - (await rows(page).evaluateAll((all, id) => all.findIndex((r) => (r as HTMLElement).dataset.itemId === id), target.id));
  expect(ahead).toBeGreaterThanOrEqual(0);
  await page.reload();
  await expect(rows(page).nth(19)).toHaveAttribute("data-item-id", target.id);
  await openRow(row);
  await row.evaluate((el) => {
    const scroller = el.closest(".page")!;
    scroller.scrollTop += el.getBoundingClientRect().top - window.innerHeight / 2;
  });
  const before = (await row.boundingBox())!.y;
  await row.getByRole("button", { name: "View draft" }).click();
  await expect(page).toHaveURL(`${stack.url}/approvals/draft-fixture`);
  // One more arrives while the owner reads the Draft, and the Inbox changes below the row: it is now the 21st.
  ahead += 1;
  const asked = page.waitForResponse((r) => isOpenList(new URL(r.url())));
  await api(page, "POST", `/attention/${last.id}/decision`, { decision: "dismiss" });
  await asked;
  await page.goBack();
  await expect(row.locator("[data-row-toggle]")).toHaveAttribute("aria-expanded", "true");
  await expect(rows(page).nth(20)).toHaveAttribute("data-item-id", target.id);
  await expect.poll(async () => Math.round((await row.boundingBox())!.y)).toBe(Math.round(before));
  await api(page, "POST", `/attention/${last.id}/decision`, { decision: "reopen" });
  await page.close();
});

test("Recently added: one line saying nothing reached the Brain without review, absent while Saving to memory is off", async () => {
  const page = await journeys.open("/");
  const recent = page.getByRole("region", { name: "Recently added" });
  await expect(recent.locator(".recently-added-line")).toHaveText(/^Recently added\s*Nothing was written without your review in the last 7 days\.$/);
  await api(page, "PUT", "/features", { changes: { capture: false }, cascade: true });
  await expect(recent).toHaveCount(0);
  await expect(rows(page).first()).toBeVisible();
  await api(page, "PUT", "/features", { changes: { capture: true }, cascade: true });
  await expect(recent).toBeVisible();
});

test("captures: the empty, failed and Recently added states in light, dark and narrow", async () => {
  const page = await journeys.newPage();
  await routeOpen(page);
  await routeCount(page, NONE);
  await page.goto(stack.url);
  const shoot = async (name: string) => {
    for (const scheme of ["light", "dark"] as const) {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.emulateMedia({ colorScheme: scheme });
      await inbox(page).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `test-results/screens/${scheme}-home-inbox-${name}.png` });
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 375, height: 812 });
    await inbox(page).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/screens/narrow-home-inbox-${name}.png` });
    await page.setViewportSize({ width: 1360, height: 900 });
  };
  await expect(emptyState(page)).toHaveAttribute("data-inbox-empty", "clear");
  await shoot("nothing-needs-you");

  await page.unroute(isCount);
  await routeCount(page, { ...NONE, signIns: 1 });
  await routeSignIn(page);
  await page.reload();
  await expect(emptyState(page).locator(".inbox-empty-line")).toHaveCount(2);
  await shoot("not-everything-read");

  await page.unrouteAll();
  await page.route(isOpenList, (route) => route.fulfill({ status: 500, json: { error: { code: "internal", message: "The Inbox store is locked" } } }));
  await page.reload();
  await expect(failure(page)).toBeVisible();
  await shoot("failed");
  await page.close();
});

test("no unresolved console errors across journeys", () => {
  expect(journeys.consoleErrors).toEqual([]);
});
