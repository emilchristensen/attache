/**
 * Jobs (#30 of spec #14): a quiet table with running work first under Running, a succeeded job without a badge, a
 * failed or blocked one with a tag and its reason, and a detail pane chosen once when the screen opens. Driven through
 * the Dashboard against the real bundled service; jobs are set up through the API, so it runs on its own.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import type { JobView } from "@attache/contracts";
import { api, JourneyBrowser } from "./browser.ts";
import { buildAll, startStack, type Stack } from "./stack.ts";

let stack: Stack;
let journeys: JourneyBrowser;

test.describe.configure({ mode: "serial" });

/** A Diagnostics job long enough to stay running for the whole journey unless it is cancelled. */
const LONG = { kind: "demo-long", title: "Diagnostics: durability check", input: { steps: 120, stepMs: 1000 } };

async function createJob(page: Page, body: Record<string, unknown>): Promise<JobView> {
  return (await api<{ job: JobView }>(page, "POST", "/jobs", body)).job;
}

async function settled(page: Page, id: string, status: JobView["status"]): Promise<void> {
  await expect.poll(async () => (await api<{ job: JobView }>(page, "GET", `/jobs/${id}`)).job.status, { timeout: 30_000 }).toBe(status);
}

const group = (page: Page, name: "Running" | "Finished") => page.getByRole("region", { name });
const row = (page: Page, id: string) => page.locator(`[data-job-row="${id}"]`);
const detail = (page: Page) => page.locator("[data-job-id]");

/** The ids of a group's rows, top to bottom. */
async function rowIds(where: Locator): Promise<string[]> {
  return where.locator("[data-job-row]").evaluateAll((rows) => rows.map((r) => r.getAttribute("data-job-row") ?? ""));
}

let research: JobView;
let failed: JobView;
let blocked: JobView;
let running: JobView;
/** A failure that arrives while the screen is open: the newest one. */
let later: JobView;

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
  research = await createJob(page, { kind: "research", input: { question: "What is the state of the Orion migration?" } });
  await settled(page, research.id, "succeeded");
  failed = await createJob(page, { kind: "demo-long", title: "Diagnostics: a failing run", input: { steps: 1, stepMs: 10, failUntilAttempt: 1, maxAttempts: 1 } });
  await settled(page, failed.id, "failed");
  blocked = await createJob(page, { kind: "draft", title: "Draft for a removed item", input: { attentionItemId: "removed-item" } });
  await settled(page, blocked.id, "blocked");
  running = await createJob(page, LONG);
  await settled(page, running.id, "running");
  await page.close();
});

test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

test("jobs: running work first under Running, a quiet success, a failure and a block named with their reasons", async () => {
  const page = await journeys.open("/jobs");
  await expect(page.getByRole("heading", { level: 1, name: "Jobs" })).toBeVisible();
  await expect.poll(() => rowIds(group(page, "Running"))).toEqual([running.id]);
  // Newest first (setup may have run work of its own, listed with them).
  const mine = [blocked.id, failed.id, research.id];
  await expect.poll(async () => (await rowIds(group(page, "Finished"))).filter((id) => mine.includes(id))).toEqual(mine);
  // Running: its progress in words, the time it started.
  await expect(row(page, running.id)).toContainText(/\d+% · Step \d+ of 120/);
  const started = (await api<{ job: JobView }>(page, "GET", `/jobs/${running.id}`)).job.startedAt!;
  await expect(row(page, running.id).locator("time")).toHaveAttribute("datetime", started);
  await expect(row(page, running.id).locator("time")).toHaveAttribute("title", /^Started (yesterday )?at \d\d:\d\d$/);
  // A success has no badge, only what it produced.
  await expect(row(page, research.id).locator(".tag")).toHaveCount(0);
  await expect(row(page, research.id)).toContainText(/Answered from \d+ sources?|No supporting evidence found/);
  // A failure and a block carry a tag and their reason.
  await expect(row(page, failed.id).locator(".tag")).toHaveText("Failed");
  await expect(row(page, failed.id)).toContainText("Simulated failure on attempt 1");
  await expect(row(page, blocked.id).locator(".tag")).toHaveText("Blocked");
  await expect(row(page, blocked.id)).toContainText("The attention item no longer exists");
  // The time column is narrow and lines up on the right.
  const times = await page.locator("[data-job-row] time").evaluateAll((ts) => ts.map((t) => t.getBoundingClientRect()));
  for (const t of times) expect(t.width, "a narrow time column").toBeLessThanOrEqual(80);
  expect(new Set(times.map((t) => Math.round(t.right))).size, "times end at one edge").toBe(1);
  expect(journeys.consoleErrors).toEqual([]);
});

test("jobs: the detail opens on the running job and live updates never change it", async () => {
  const page = await journeys.open("/jobs");
  await expect(detail(page)).toHaveAttribute("data-job-id", running.id);
  await expect(row(page, running.id).getByRole("button")).toHaveAttribute("aria-current", "true");
  // The choice is not written to the address; only a pick is.
  await expect(page).toHaveURL(`${stack.url}/jobs`);
  // New work arrives and other work fails while the screen is open: the list takes them in, the selection stays.
  later = await createJob(page, { kind: "demo-long", title: "Diagnostics: another failing run", input: { steps: 1, stepMs: 10, failUntilAttempt: 1, maxAttempts: 1 } });
  await expect(row(page, later.id).locator(".tag")).toHaveText("Failed");
  const progress = detail(page).getByRole("progressbar");
  const before = Number(await progress.getAttribute("aria-valuenow"));
  await expect.poll(async () => Number(await progress.getAttribute("aria-valuenow"))).toBeGreaterThan(before);
  await expect(detail(page)).toHaveAttribute("data-job-id", running.id);
  // Cancel says the work stopped; the job moves to Finished and stays the one shown.
  await detail(page).getByRole("button", { name: "Cancel" }).click();
  await expect(detail(page)).toHaveAttribute("data-status", "cancelled");
  await expect(detail(page).getByRole("status")).toHaveText("Stopped: the work ended before it finished.");
  await expect.poll(() => rowIds(group(page, "Running"))).toEqual([]);
  await expect(group(page, "Running")).toContainText("Nothing is running.");
  await expect(row(page, running.id)).toContainText("Cancelled, stopped early");
  await expect(row(page, running.id).locator(".tag")).toHaveCount(0);
  await expect(detail(page)).toHaveAttribute("data-job-id", running.id);
  await expect(page).toHaveURL(`${stack.url}/jobs`);
  expect(journeys.consoleErrors).toEqual([]);
});

test("jobs: with nothing running it opens on the newest failure; a pick goes in the address and survives a reload", async () => {
  const page = await journeys.open("/jobs");
  // Nothing runs now; the newest job is a cancelled one, but the newest failure comes first.
  await expect(detail(page)).toHaveAttribute("data-job-id", later.id);
  // Picking another row opens it and records it in the address, so Back and a reload come back to it.
  await row(page, research.id).getByRole("button").click();
  await expect(detail(page)).toHaveAttribute("data-job-id", research.id);
  await expect(page).toHaveURL(`${stack.url}/jobs?id=${research.id}`);
  await expect(row(page, research.id).getByRole("button")).toHaveAttribute("aria-current", "true");
  await page.reload();
  await expect(detail(page)).toHaveAttribute("data-job-id", research.id);
  await expect(detail(page).getByRole("button", { name: /Open deliverables\/research/ })).toBeVisible();
  // Retry puts a failed job back to work, under Running, and it stays selected.
  await row(page, failed.id).getByRole("button").click();
  await expect(detail(page)).toHaveAttribute("data-job-id", failed.id);
  await expect(detail(page)).toContainText("Simulated failure on attempt 1");
  await detail(page).getByRole("button", { name: "Retry" }).click();
  await expect(detail(page)).toHaveAttribute("data-status", "succeeded");
  await expect(row(page, failed.id).locator(".tag")).toHaveCount(0);
  await expect(detail(page)).toHaveAttribute("data-job-id", failed.id);
  expect(journeys.consoleErrors).toEqual([]);
});

test("jobs: Cancel says the job had already finished when the request arrives after the work is done", async () => {
  const page = await journeys.open("/jobs");
  const short = await createJob(page, { kind: "demo-long", title: "Diagnostics: a short run", input: { steps: 3, stepMs: 1000 } });
  await page.goto(`${stack.url}/jobs?id=${short.id}`);
  await expect(detail(page)).toHaveAttribute("data-status", "running");
  // Hold the cancel request until the work has finished, as a slow network would.
  await page.route(`**/api/v1/jobs/${short.id}/cancel`, async (route) => {
    await settled(page, short.id, "succeeded");
    await route.continue();
  });
  await detail(page).getByRole("button", { name: "Cancel" }).click();
  await expect(detail(page).getByRole("status")).toHaveText("Already finished: the cancel came after the work was done, so its result stands.");
  await expect(detail(page)).toHaveAttribute("data-status", "succeeded");
  await expect(row(page, short.id)).toContainText("Finished before the cancel");
  await expect(detail(page).getByRole("button", { name: "Cancel" })).toHaveCount(0);
  await page.unroute(`**/api/v1/jobs/${short.id}/cancel`);
  expect(journeys.consoleErrors).toEqual([]);
});

test("jobs: Research and Diagnostics start work and open it", async () => {
  const page = await journeys.open("/jobs");
  await page.getByRole("textbox", { name: "Research question" }).fill("Who owns the Atlas launch?");
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await expect(detail(page)).toContainText("Who owns the Atlas launch?");
  await expect(page).toHaveURL(/\/jobs\?id=/);
  await expect(page.getByRole("textbox", { name: "Research question" })).toHaveValue("");
  await page.getByRole("button", { name: "Diagnostics", exact: true }).click();
  await expect(detail(page)).toHaveAttribute("data-status", /queued|running/);
  const id = (await detail(page).getAttribute("data-job-id"))!;
  await expect(group(page, "Running").locator(`[data-job-row="${id}"]`)).toBeVisible();
  await detail(page).getByRole("button", { name: "Cancel" }).click();
  await expect(detail(page)).toHaveAttribute("data-status", "cancelled");
  expect(journeys.consoleErrors).toEqual([]);
});

test("jobs narrow: the table fits a phone, a picked job opens below it in view", async () => {
  const page = await journeys.open("/jobs");
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${stack.url}/jobs`);
    await expect(row(page, research.id)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `no horizontal overflow at ${width}px`).toBeLessThanOrEqual(0);
    const [title, time] = [await row(page, blocked.id).locator(".job-title").boundingBox(), await row(page, blocked.id).locator("time").boundingBox()];
    expect(time!.x, `the time stays beside the title at ${width}px`).toBeGreaterThan(title!.x);
    await row(page, research.id).getByRole("button").click();
    await expect(detail(page)).toHaveAttribute("data-job-id", research.id);
    await expect(detail(page)).toBeInViewport();
  }
  await page.setViewportSize({ width: 1360, height: 900 });
  expect(journeys.consoleErrors).toEqual([]);
});

test("jobs captures: the table with every state, a failure open, light, dark and narrow", async () => {
  const page = await journeys.open("/jobs");
  const shots = "test-results/screens";
  const long = await createJob(page, LONG);
  await settled(page, long.id, "running");
  for (const [scheme, viewport] of [["light", { width: 1280, height: 800 }], ["dark", { width: 1280, height: 800 }], ["narrow", { width: 390, height: 844 }]] as const) {
    await page.emulateMedia({ colorScheme: scheme === "dark" ? "dark" : "light" });
    await page.setViewportSize(viewport);
    await page.goto(`${stack.url}/jobs`);
    await expect(detail(page)).toHaveAttribute("data-job-id", long.id);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/${scheme}-jobs-table.png` });
    await page.goto(`${stack.url}/jobs?id=${blocked.id}`);
    await expect(detail(page)).toHaveAttribute("data-status", "blocked");
    await detail(page).scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/${scheme}-jobs-blocked.png` });
  }
  await api(page, "POST", `/jobs/${long.id}/cancel`);
  expect(journeys.consoleErrors).toEqual([]);
});

test("jobs: a failure behind a full page of newer successes is still the one the detail opens on", async () => {
  const page = await journeys.open("/jobs");
  // Fifty quick successes, newer than every failure: Finished's first page holds only them.
  for (let i = 0; i < 50; i++) await createJob(page, { kind: "demo-long", title: `Diagnostics: quick run ${i + 1}`, input: { steps: 1, stepMs: 1, effectAtStep: -1 } });
  await expect.poll(async () => (await api<JobView[]>(page, "GET", "/jobs?status=queued,running&limit=100")).length, { timeout: 60_000 }).toBe(0);
  await page.goto(`${stack.url}/jobs`);
  await expect.poll(async () => (await rowIds(group(page, "Finished"))).length).toBe(50);
  await expect(row(page, later.id)).toHaveCount(0);
  await expect(detail(page)).toHaveAttribute("data-job-id", later.id);
  // Finished pages back to it.
  await group(page, "Finished").getByRole("button", { name: "Show 50 more" }).click();
  await expect(row(page, later.id).locator(".tag")).toHaveText("Failed");
  expect(journeys.consoleErrors).toEqual([]);
});

test("jobs: a refresh of the open job that fails says so beside what it still shows, and Try again recovers", async () => {
  const page = await journeys.open(`/jobs?id=${blocked.id}`);
  await expect(detail(page)).toHaveAttribute("data-status", "blocked");
  const job = `**/api/v1/jobs/${blocked.id}`;
  await page.route(job, (route) => (route.request().method() === "GET" ? route.abort() : route.continue()));
  await detail(page).getByRole("button", { name: "Retry" }).click();
  const failure = detail(page).getByRole("alert");
  await expect(failure).toContainText("This job could not be refreshed. What shows here may be out of date.");
  await expect(detail(page).getByRole("heading", { level: 2, name: "Draft for a removed item" })).toBeVisible();
  await page.unroute(job);
  await failure.getByRole("button", { name: "Try again" }).click();
  await expect(failure).toHaveCount(0);
  await expect(detail(page)).toHaveAttribute("data-status", "blocked");
  expect(journeys.consoleErrors).toEqual([]);
});

test("jobs: Cancel says the job was already cancelled when an earlier cancel stopped it first", async () => {
  const page = await journeys.open("/jobs");
  const long = await createJob(page, LONG);
  await page.goto(`${stack.url}/jobs?id=${long.id}`);
  await expect(detail(page)).toHaveAttribute("data-status", "running");
  // Another tab cancels first; this tab's request arrives after the work has stopped.
  const other = await journeys.newPage();
  await other.goto(`${stack.url}/jobs`);
  await page.route(`**/api/v1/jobs/${long.id}/cancel`, async (route) => {
    await api(other, "POST", `/jobs/${long.id}/cancel`);
    await settled(other, long.id, "cancelled");
    await route.continue();
  });
  await detail(page).getByRole("button", { name: "Cancel" }).click();
  await expect(detail(page).getByRole("status")).toHaveText("Already cancelled: the work had stopped before this request.");
  await expect(detail(page)).toHaveAttribute("data-status", "cancelled");
  await page.unroute(`**/api/v1/jobs/${long.id}/cancel`);
  expect(journeys.consoleErrors).toEqual([]);
});
