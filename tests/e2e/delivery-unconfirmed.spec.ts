/**
 * Delivery unconfirmed (#37 of spec #14): a Draft whose send has an unknown outcome marks its Inbox item, Check
 * destination comes first, and a replacement Draft takes a separate explicit choice. Driven through the Dashboard
 * against the real bundled service and the TEST-ONLY fixtures (GitHub, whose read-back of the posted comment is made
 * to fail, Gmail and a notes folder, for a mixed flat Inbox); it runs on its own.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, JourneyBrowser } from "./browser.ts";
import { approvalRowById, openApprovalRow } from "./approvals.ts";
import { inboxRow, openRow } from "./inbox.ts";
import { buildAll, startStack, type Stack } from "./stack.ts";

let stack: Stack;
let journeys: JourneyBrowser;

test.describe.configure({ mode: "serial" });

const SUBJECT = "Add checkout retry";
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
/** Enough deadlines that the Inbox runs past the window, so the open row has somewhere to be scrolled to. */
const TASKS = Array.from({ length: 14 }, (_, i) => `Check supplier contract ${String(i + 1).padStart(2, "0")}`);

interface Item {
  id: string;
  title: string;
  state: string;
  actionId: string | null;
  actionStatus: string | null;
}

const reviewItem = async (page: Page): Promise<Item> => (await api<{ items: Item[] }>(page, "GET", "/attention?state=open,dismissed,snoozed,resolved")).items.find((i) => i.title.includes(SUBJECT))!;

test.beforeAll(async ({ browser }) => {
  buildAll();
  stack = await startStack();
  writeFileSync(join(stack.vaultDir, "Projects/Suppliers.md"), `# Suppliers\n\n## Tasks\n${TASKS.map((t, i) => `- [ ] ${t} 📅 ${day(3 + i)}`).join("\n")}\n`);
  journeys = await JourneyBrowser.start(browser, stack.url);
  const page = await journeys.newPage();
  await page.goto(stack.pairUrl());
  await expect(page.getByRole("heading", { name: "Where should Attache keep your knowledge?" })).toBeVisible();
  await api(page, "POST", "/setup/data-folder", { path: stack.dataDir });
  await api(page, "POST", "/setup/identity", { name: "Test User", email: "alex@example.com", confirm: true });
  await api(page, "POST", "/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${stack.fixtureUrl}/model`, model: "fixture-model" } });
  await api(page, "POST", "/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678" } });
  await api(page, "PUT", "/connections/github/write-actions", { writeActions: ["github.comment"], confirm: true });
  await api(page, "POST", "/connections/gmail/configure", { method: "claude-ai", fields: {} });
  await api(page, "POST", "/setup/complete");
  await api(page, "POST", "/import", { path: stack.vaultDir });
  await api(page, "POST", "/connections/github/refresh");
  await api(page, "POST", "/connections/gmail/refresh");
  const kinds = async () => new Set((await api<{ items: Array<{ kind: string }> }>(page, "GET", "/attention?state=open")).items.map((i) => i.kind));
  await expect.poll(async () => [...(await kinds())].sort(), { timeout: 60_000 }).toEqual(expect.arrayContaining(["deadline", "pending_reply", "review_request"]));
  await expect.poll(async () => (await api<{ items: unknown[] }>(page, "GET", "/attention?state=open")).items.length, { timeout: 30_000 }).toBeGreaterThan(TASKS.length);
  // Every send from now on posts its comment, but reading it back fails: the outcome is unknown.
  await fetch(`${stack.fixtureUrl}/__control/github-read-back`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ fails: true }) });
  await page.close();
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

/** The decision count as the shell shows it: the tab title's total, Home's own part and the Approvals badge. */
async function shownCount(page: Page): Promise<{ total: number; home: number; approvals: number }> {
  await expect(page).toHaveTitle(/^\(\d+\) Attache$/);
  const total = Number((await page.title()).match(/^\((\d+)\)/)![1]);
  const need = (await page.locator("[data-need-you]").textContent()) ?? "";
  const home = Number(need.match(/(\d+) needs? you here/)?.[1] ?? 0);
  const badge = await page.getByRole("navigation").getByRole("link", { name: /^Approvals/ }).first().getAttribute("aria-label");
  const approvals = Number(badge?.match(/(\d+) waiting/)?.[1] ?? 0);
  return { total, home, approvals };
}

/** Waits until the shell shows `expected`, so every part has settled after a decision. */
async function expectCount(page: Page, expected: { total: number; home: number; approvals: number }, what: string): Promise<void> {
  await expect.poll(() => shownCount(page), { message: what, timeout: 15_000 }).toEqual(expected);
}

const actionNames = (row: Locator) => row.locator(".inbox-actions > :is(a, button)").evaluateAll((els) => els.map((e) => e.textContent?.trim()));

test("a send of unknown outcome: back on Home the open row and its place survive the round trip, and the collapsed row says Delivery unconfirmed after a reload", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 1280, height: 800 });
  const row = inboxRow(page, SUBJECT);
  await openRow(row);
  await row.getByRole("button", { name: "Prepare draft" }).click();
  await expect(row.getByRole("button", { name: "View draft" })).toBeVisible({ timeout: 30_000 });
  // The open row sits part way down the page, with rows above and below it.
  const scroller = page.locator(".page");
  await scroller.evaluate((el, by) => el.scrollBy(0, by), (await row.boundingBox())!.y - 240);
  const placed = (await row.boundingBox())!.y;
  expect(await scroller.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  await row.getByRole("button", { name: "View draft" }).click();
  await expect(page).toHaveURL(/\/approvals\/[^/?]+$/);
  await page.getByRole("button", { name: "Approve v1" }).click();
  await page.getByRole("button", { name: "Send v1" }).click();
  await expect(page.locator("[data-action-id]")).toHaveAttribute("data-status", "unknown", { timeout: 30_000 });
  await expect(page.locator(".draft-meta .tag")).toHaveText("Outcome unknown");
  // Back on Home: the same row is open, where it was, and leads with Check destination.
  await page.goBack();
  await expect(row.locator("[data-row-toggle]")).toHaveAttribute("aria-expanded", "true");
  await expect(row.locator(".inbox-source")).toContainText("Delivery unconfirmed");
  await expect.poll(async () => Math.round((await row.boundingBox())!.y)).toBe(Math.round(placed));
  await expect(row.locator(".inbox-actions > :is(a, button)").first()).toHaveText("Check destination");
  // A reload keeps the warning: it is the stored outcome, not a message of the moment.
  await page.reload();
  await expect(row.locator(".inbox-source")).toContainText("Delivery unconfirmed");
  // Captures: the collapsed type, subject and label on a mixed flat Inbox, then the open row, in light, dark and narrow.
  if ((await row.locator("[data-row-toggle]").getAttribute("aria-expanded")) === "true") await row.locator("[data-row-toggle]").click();
  await expect(row.locator(".inbox-kind-word")).toHaveText("Review request");
  await expect(row.locator("[data-row-toggle]")).toHaveText(SUBJECT);
  const kinds = await page.locator("#inbox [data-inbox-row] .inbox-kind-word").allTextContents();
  expect(kinds).toEqual(expect.arrayContaining(["Review request", "Pending reply", "Deadline"]));
  const captures = [
    ["light", { width: 1280, height: 800 }],
    ["dark", { width: 1280, height: 800 }],
    ["narrow", { width: 360, height: 780 }],
  ] as const;
  for (const [name, viewport] of captures) {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ colorScheme: name === "dark" ? "dark" : "light" });
    for (const open of [false, true]) {
      if (open) await openRow(row);
      await row.scrollIntoViewIfNeeded();
      // No hover or focus fill on the row in the picture.
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.screenshot({ path: `test-results/screens/${name}-home-inbox-delivery-unconfirmed${open ? "-open" : ""}.png` });
    }
    await row.locator("[data-row-toggle]").click();
  }
  await page.emulateMedia({ colorScheme: null });
  await page.close();
});

test("from Home after the send: Check destination opens the destination and changes nothing, the original Draft and its receipt are a link away, a replacement takes its own choice, and the item is one decision throughout", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator(".toast")).toHaveCount(0);
  const row = inboxRow(page, SUBJECT);
  await expect(row.locator(".inbox-source")).toContainText("Delivery unconfirmed");
  const before = await reviewItem(page);
  expect(before).toMatchObject({ state: "open", actionStatus: "unknown" });
  const draft = await api<{ receipt: { url: string } }>(page, "GET", `/actions/${before.actionId}`);
  const count = await shownCount(page);
  // The uncertain item counts once, on Home: its Draft no longer waits in Approvals.
  expect(count.total).toBe(count.home + count.approvals);

  await openRow(row);
  await expect(row.locator(".draft-notice")).toContainText("The outcome could not be verified. The request may have reached GitHub. Check the pull request before you do anything else.");
  expect(await actionNames(row)).toEqual(["Check destination", "View the Draft", "Open in GitHub", "Prepare a replacement", "Done", "Snooze", "Dismiss"]);
  await expect(row.getByRole("button", { name: "Prepare draft" })).toHaveCount(0);

  // Check destination opens where the comment was posted, in a new tab, and decides nothing.
  await journeys.context.route("https://github.com/**", (r) => r.fulfill({ contentType: "text/html", body: "<title>acme/web #42</title>" }));
  const check = row.getByRole("link", { name: "Check destination" });
  await expect(check).toHaveAttribute("href", draft.receipt.url);
  await expect(check).toHaveAttribute("target", "_blank");
  const [tab] = await Promise.all([page.waitForEvent("popup"), check.click()]);
  await expect(tab).toHaveURL(draft.receipt.url);
  await tab.close();
  await expect(row.locator("[data-row-toggle]")).toHaveAttribute("aria-expanded", "true");
  await expect(row.locator(".inbox-source")).toContainText("Delivery unconfirmed");
  expect(await reviewItem(page)).toMatchObject({ state: "open", actionId: before.actionId, actionStatus: "unknown" });
  await expectCount(page, count, "after Check destination");

  // The original Draft and its receipt.
  await row.getByRole("button", { name: "View the Draft" }).click();
  await expect(page).toHaveURL(new RegExp(`/approvals/${before.actionId}$`));
  await expect(page.locator("[data-receipt]")).toContainText(draft.receipt.url);
  await expect(page.locator("[data-receipt]")).toContainText("No, the outcome is unknown");
  // Approvals lists it under Finished, with the same warning and Check destination first.
  await page.goto(`${stack.url}/approvals?tab=finished`);
  const finished = approvalRowById(page, "draft", before.actionId!);
  await expect(finished.locator(".approval-meta .tag")).toHaveText("Outcome unknown");
  await openApprovalRow(finished);
  await expect(finished.locator(".draft-notice")).toContainText("Check the pull request before you do anything else.");
  await expect(finished.locator(".approval-actions > :is(a, button)").first()).toHaveText("Check destination");
  await expect(finished.getByRole("link", { name: "Check destination" })).toHaveAttribute("href", draft.receipt.url);
  await page.goto(stack.url);
  await openRow(row);
  await expect(row.locator("[data-row-toggle]")).toHaveAttribute("aria-expanded", "true");

  // Prepare a replacement only opens the choice, with the warning; Cancel leaves everything as it was.
  const replace = row.getByRole("button", { name: "Prepare a replacement", exact: true });
  await replace.click();
  await expect(replace).toHaveAttribute("aria-expanded", "true");
  const choice = row.getByRole("group", { name: "Prepare a replacement" });
  await expect(choice).toContainText("Only if the message did not arrive. A replacement is a new Draft for this item; nothing is sent until you approve and send it.");
  await choice.getByRole("button", { name: "Cancel" }).click();
  await expect(choice).toHaveCount(0);
  await expect(replace).toBeFocused();
  expect(await reviewItem(page)).toMatchObject({ actionId: before.actionId, actionStatus: "unknown" });
  await expectCount(page, count, "after Cancel");

  // The explicit choice prepares a new Draft: the item's decision moves to Approvals and still counts once.
  await replace.click();
  await row.getByRole("group", { name: "Prepare a replacement" }).getByRole("button", { name: "Prepare a replacement Draft" }).click();
  await expect(row.locator(".inbox-source")).toContainText("Draft waiting", { timeout: 30_000 });
  await expect(row.locator(".inbox-source")).not.toContainText("Delivery unconfirmed");
  const replaced = await reviewItem(page);
  expect(replaced.actionId).not.toBe(before.actionId);
  expect(replaced.actionStatus).toBe("draft");
  expect((await api<{ status: string }>(page, "GET", `/actions/${before.actionId}`)).status).toBe("unknown");
  await expectCount(page, { total: count.total, home: count.home - 1, approvals: count.approvals + 1 }, "after the replacement");

  // Done resolves the item; its replacement Draft still waits in Approvals, so the total does not move.
  await row.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator('#inbox [data-decided="done"]', { hasText: SUBJECT })).toBeVisible();
  expect((await reviewItem(page)).state).toBe("resolved");
  await expectCount(page, { total: count.total, home: count.home - 1, approvals: count.approvals + 1 }, "after Done");
  await page.close();
});

test("no unresolved console errors across journeys", () => {
  expect(journeys.consoleErrors).toEqual([]);
});
