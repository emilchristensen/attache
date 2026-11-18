/**
 * Changes reach the Brain without review (ADR 0004): auto-accept per Harness,
 * the Consolidation switch, and Home's Recently added, driven through the
 * Dashboard against the real bundled service and the TEST-ONLY fixtures.
 */
import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { approvalRow, draftsGroup, openApprovalRow, proposalsGroup, waitingTab } from "./approvals.ts";
import { api, JourneyBrowser } from "./browser.ts";
import { openRecentlyAdded } from "./inbox.ts";
import { arriveMeetingCapture, buildAll, harnessSave, startStack, type Stack } from "./stack.ts";

let stack: Stack;
let journeys: JourneyBrowser;

test.describe.configure({ mode: "serial" });

/** Claude Code's auto-accept switched as the owner does in Settings. */
const claudeCodeAutoAccept = (page: Page, autoAccept: boolean) => api(page, "PUT", "/harnesses/claude-code/auto-accept", { autoAccept });

test.beforeAll(async ({ browser }) => {
  buildAll();
  stack = await startStack();
  journeys = await JourneyBrowser.start(browser, stack.url);
  // A finished setup with a model and no Harness: the onboarding journey in journeys.spec.ts drives these steps by hand.
  const page = await journeys.newPage();
  await page.goto(stack.pairUrl());
  await expect(page.getByRole("heading", { name: "Where should Attache keep your knowledge?" })).toBeVisible();
  await api(page, "POST", "/setup/data-folder", { path: stack.dataDir });
  await api(page, "POST", "/setup/identity", { name: "Test User", email: "alex@example.com", confirm: true });
  await api(page, "POST", "/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${stack.fixtureUrl}/model`, model: "fixture-model" } });
  await api(page, "POST", "/setup/complete");
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

test("consolidation switch: shows in Settings with no Harness connected", async () => {
  const page = await journeys.open("/settings");
  const card = page.getByRole("region", { name: "Auto-accept" });
  await expect(card).toContainText("No Harness is connected. Connect one under Connections.");
  await expect(card.getByRole("checkbox")).toHaveCount(1);
  const row = card.locator("[data-consolidation]");
  await expect(row.getByRole("checkbox", { name: "Consolidation" })).toBeChecked();
  await expect(row).toContainText("Writes what it finds in finished sessions and meetings without asking.");
});

test("home: Recently added says in one line that nothing reached the Brain without review", async () => {
  const page = await journeys.open("/");
  const section = page.getByRole("region", { name: "Recently added" });
  await expect(section).toBeVisible();
  await expect(section).toContainText("Nothing was written without your review in the last 7 days.");
  await expect(section.getByRole("listitem")).toHaveCount(0);
  // With no work source only the notes are read: Connections says Notes only, the empty Inbox says what was read, and the logo shows no dot.
  await expect(page.getByRole("status", { name: "Connections" }).locator('[data-state="notes_only"] .conn-row-line')).toHaveText("Notes · Notes only · Only your notes are read");
  const empty = page.locator("#inbox [data-inbox-empty]");
  await expect(empty.locator(".inbox-empty-title")).toHaveText("Nothing found in your notes.");
  await expect(empty).toContainText("No work source is connected, so only your notes were read.");
  await expect(page.locator(".masthead .brand .logo-dot")).toHaveCount(0);
});

/** The dot, favicon and tab title, which follow the one count behind every number in the navigation. */
async function expectTab(page: Page, want: { dot: boolean; title: string }) {
  await expect(page).toHaveTitle(want.title);
  await expect(page.locator(".masthead .brand .logo-dot")).toHaveCount(want.dot ? 1 : 0);
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", want.dot ? "/favicon.svg" : "/favicon-quiet.svg");
}

const lenaBerg = { item: { action: "create", type: "person", title: "Lena Berg", facts: [{ subject: "Role", value: "Postmark account manager" }] }, reason: "Introduced in the vendor call" };

test("the dot: a waiting Proposal lights the logo, favicon and tab title, and they go out when it is decided", async () => {
  const page = await journeys.open("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(page.getByRole("heading", { level: 2, name: "Inbox" })).toBeVisible();
  await expectTab(page, { dot: false, title: "Attache" });
  await expect(page.locator("[data-need-you]")).toHaveCount(0);

  // A Proposal arrives while the page is open: one decision waits, in Approvals.
  await api(page, "POST", "/memory/proposals", lenaBerg);
  await expectTab(page, { dot: true, title: "(1) Attache" });
  await expect(nav.getByRole("link", { name: "Approvals, 1 waiting" }).locator(".count")).toHaveText("1");
  await expect(page.getByRole("link", { name: "Attache, 1 needs you" })).toBeVisible();

  // Deciding it in Approvals puts the dot out everywhere.
  await nav.getByRole("link", { name: /^Approvals/ }).click();
  const proposal = approvalRow(page, "proposal", "Lena Berg");
  await openApprovalRow(proposal);
  // The decision's answer arrives only after the list was read again without the Proposal: the row keeps its place
  // meanwhile and then becomes its one line.
  const refetched = page.waitForResponse((r) => r.url().includes("/api/v1/memory/proposals?status=proposed") && r.request().method() === "GET");
  const reject = "**/api/v1/memory/proposals/*/reject";
  await page.route(reject, async (route) => {
    const response = await route.fetch();
    await refetched;
    await route.fulfill({ response });
  });
  await proposal.getByRole("button", { name: "Reject" }).click();
  expect((await (await refetched).json()).proposals).toEqual([]);
  await expect(proposal).toHaveAttribute("data-decided", "Rejected");
  await page.unroute(reject);
  await expectTab(page, { dot: false, title: "Attache" });
  await expect(nav.getByRole("link", { name: "Approvals" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Attache" })).toBeVisible();
});

test("the dot: a request that fails leaves the dot as it was and shows no number, until the count is read again", async () => {
  const page = await journeys.open("/");
  const nav = page.getByRole("navigation", { name: "Main" });
  const proposal = await api<{ id: string }>(page, "POST", "/memory/proposals", lenaBerg);
  await expectTab(page, { dot: true, title: "(1) Attache" });

  // The count route and the Proposals list it falls back to stop answering, and the Proposal is decided elsewhere:
  // the count cannot tell, so the dot keeps its last state and no number is claimed.
  await page.route("**/api/v1/decision-count", (route) => route.abort());
  await page.route("**/api/v1/memory/proposals?*", (route) => route.abort());
  await api(page, "POST", `/memory/proposals/${proposal.id}/reject`);
  await expect(nav.getByRole("link", { name: "Approvals" })).toBeVisible();
  await expectTab(page, { dot: true, title: "Attache" });

  // Read again, the exact zero puts it out.
  await page.unroute("**/api/v1/decision-count");
  await page.unroute("**/api/v1/memory/proposals?*");
  await page.reload();
  await expect(page.getByRole("heading", { level: 2, name: "Inbox" })).toBeVisible();
  await expectTab(page, { dot: false, title: "Attache" });
});

test("count: above the lists' limits the count route keeps every number exact, and when it fails the full list shows a lower bound", async () => {
  const page = await journeys.open("/");
  const approvals = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Approvals/ });
  // One more Proposal than the Proposals list returns (its limit is 100).
  const made: string[] = [];
  try {
    for (let i = 0; i < 101; i++) made.push((await api<{ id: string }>(page, "POST", "/memory/proposals", { item: { action: "create", type: "note", title: `Counted note ${i}`, facts: [{ subject: "Status", value: `Draft ${i}` }] }, reason: "count journey" })).id);
    await expectTab(page, { dot: true, title: "(101) Attache" });
    await expect(approvals).toHaveAccessibleName("Approvals, 101 waiting");
    await expect(approvals.locator(".count")).toHaveText("101");

    // The count route fails: the count falls back to the lists, and a full list is a lower bound.
    await page.route("**/api/v1/decision-count", (route) => route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "busy" } } }));
    await page.reload();
    await expectTab(page, { dot: true, title: "(100+) Attache" });
    await expect(approvals).toHaveAccessibleName("Approvals, at least 100 waiting");
    await expect(approvals.locator(".count")).toHaveText("100+");

    // It answers again: exact once more.
    await page.unroute("**/api/v1/decision-count");
    await page.reload();
    await expectTab(page, { dot: true, title: "(101) Attache" });
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    for (const id of made) await api(page, "POST", `/memory/proposals/${id}/reject`);
  }
  await expectTab(page, { dot: false, title: "Attache" });
});

test("approvals: each group answers for its own request, the Waiting tab and navigation show a lower bound, and nothing-waits is said only when both answered", async () => {
  const page = await journeys.open("/approvals");
  const nav = page.getByRole("navigation", { name: "Main" });
  // Both answered with nothing: the one true empty state.
  await expect(page.getByText("Nothing waits for your OK.")).toBeVisible();
  await expect(waitingTab(page)).toHaveAccessibleName("Waiting");

  // The waiting Drafts and the count route stop answering while a Proposal waits: the Drafts group says it does not
  // know, the Proposal still shows, and the tab and navigation give the known part as a lower bound.
  const drafts = "**/api/v1/actions?status=draft,approved,revoked*";
  const route = "**/api/v1/decision-count";
  await page.route(drafts, (r) => r.abort());
  await page.route(route, (r) => r.abort());
  const proposal = await api<{ id: string }>(page, "POST", "/memory/proposals", lenaBerg);
  await page.reload();
  await expect(draftsGroup(page).getByRole("alert")).toContainText("Drafts could not be loaded. This is not an empty list");
  await expect(approvalRow(proposalsGroup(page), "proposal", "Lena Berg")).toBeVisible();
  await expect(page.getByText("Nothing waits for your OK.")).toHaveCount(0);
  await expect(waitingTab(page)).toHaveAccessibleName("Waiting, at least 1 waiting");
  await expect(waitingTab(page).locator(".count")).toHaveText("1+");
  await expect(nav.getByRole("link", { name: "Approvals, at least 1 waiting" }).locator(".count")).toHaveText("1+");

  // Retry reads them again: nothing waits there, and the count is exact.
  await page.unroute(drafts);
  await page.unroute(route);
  await draftsGroup(page).getByRole("button", { name: "Retry" }).click();
  await expect(draftsGroup(page)).toContainText("No Drafts wait.");
  await expect(waitingTab(page)).toHaveAccessibleName("Waiting, 1 waiting");

  // After a good load the Proposals stop answering: the row stays, with when it was loaded, beside the failure. The
  // count route still counts the new one, so the count stays exact and the failure does not say it leaves them out.
  const proposals = "**/api/v1/memory/proposals?*";
  await page.route(proposals, (r) => r.abort());
  await api(page, "POST", "/memory/proposals", { ...lenaBerg, item: { ...lenaBerg.item, title: "Ola Berg" } });
  await expect(proposalsGroup(page).getByRole("alert")).toContainText(/^Proposals could not be refreshed\. These are the rows from \d\d:\d\d\. They may have changed\. /);
  await expect(approvalRow(proposalsGroup(page), "proposal", "Lena Berg")).toBeVisible();
  await expect(waitingTab(page)).toHaveAccessibleName("Waiting, 2 waiting");
  // While the count is on the lists as well, the failed group drops out of it, and the failure says so.
  await page.route(route, (r) => r.abort());
  await api(page, "POST", "/memory/proposals", { ...lenaBerg, item: { ...lenaBerg.item, title: "Mia Berg" } });
  await expect(proposalsGroup(page).getByRole("alert")).toContainText(/^Proposals could not be refreshed\. These are the rows from \d\d:\d\d\. They may have changed, and the count leaves them out\./);
  await expect(waitingTab(page)).toHaveAccessibleName("Waiting");
  await page.unroute(route);
  await page.unroute(proposals);
  await proposalsGroup(page).getByRole("button", { name: "Retry" }).click();
  await expect(waitingTab(page)).toHaveAccessibleName("Waiting, 3 waiting");

  // Clear them for the journeys after this one.
  for (const p of (await api<{ proposals: Array<{ id: string }> }>(page, "GET", "/memory/proposals")).proposals) await api(page, "POST", `/memory/proposals/${p.id}/reject`);
  expect(proposal.id).toBeTruthy();
});

test("approvals: when the last Proposal is decided elsewhere, nothing-waits waits until the count agrees", async () => {
  const page = await journeys.open("/approvals");
  const proposal = await api<{ id: string }>(page, "POST", "/memory/proposals", lenaBerg);
  const row = approvalRow(proposalsGroup(page), "proposal", "Lena Berg");
  await expect(row).toBeVisible();
  await expect(waitingTab(page)).toHaveAccessibleName("Waiting, 1 waiting");

  // The Proposals list answers while the count route is still held: the row goes, but the count still has it.
  const route = "**/api/v1/decision-count";
  let release!: () => void;
  const holding = new Promise<void>((r) => (release = r));
  try {
    await page.route(route, (r) => holding.then(() => r.continue()).catch(() => undefined));
    await api(page, "POST", `/memory/proposals/${proposal.id}/reject`);
    await expect(row).toHaveCount(0);
    await expect(waitingTab(page)).toHaveAccessibleName("Waiting, 1 waiting");
    await expect(page.getByText("Nothing waits for your OK.")).toHaveCount(0);
    release();
    await expect(page.getByText("Nothing waits for your OK.")).toBeVisible();
    await expect(waitingTab(page)).toHaveAccessibleName("Waiting");
  } finally {
    release();
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});

test("auto-accept: on by default for a connected Harness, switched off in Settings and kept across reload, and only saves written without review are marked", async () => {
  const page = await journeys.open("/connections");
  // On the full Connections page an unconfigured card opens straight into its setup form.
  const claudeCode = page.locator('[data-connection="claude-code"]');
  await claudeCode.getByRole("button", { name: "Connect" }).click();
  await expect(claudeCode.getByText("connected", { exact: true })).toBeVisible();

  await page.goto(`${stack.url}/settings`);
  const card = page.getByRole("region", { name: "Auto-accept" });
  await expect(card.getByText("A connected Harness writes its saves to your Brain without review.")).toBeVisible();
  // Only connected Harnesses are listed: Claude Code is, Codex is not.
  const claude = card.getByRole("checkbox", { name: /Claude Code/ });
  await expect(claude).toBeChecked();
  await expect(card.getByText("Saves without asking.")).toBeVisible();
  await expect(card.getByRole("checkbox", { name: /Codex/ })).toHaveCount(0);

  // A save from Claude Code goes through without asking. The Dashboard itself cannot save.
  await harnessSave(stack, [{ action: "create", type: "note", title: "Nebula naming", facts: [{ subject: "Idea", value: "Name releases after nebulae" }] }], { agent: "claude-code", session: "sess-auto" });
  const dashboardSave = await page.evaluate(async () => {
    const body = { items: [{ action: "create", type: "note", title: "Typed in the Dashboard", facts: [{ subject: "Idea", value: "x" }] }] };
    const res = await fetch("/api/v1/memory/save", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-attache-client": "1" }, body: JSON.stringify(body) });
    return res.status;
  });
  expect(dashboardSave).toBe(403);
  await page.goto(`${stack.url}/brain/recent`);
  const created = page.getByRole("region", { name: "Recent saves" }).getByRole("listitem").filter({ hasText: "Nebula naming" });
  await expect(created).toContainText("Claude Code, session sess-auto");
  await expect(created).toContainText("auto-accepted");

  // Switched off, the Harness asks before every save, and a save the owner confirmed carries no mark.
  await page.goto(`${stack.url}/settings`);
  const off = page.getByRole("region", { name: "Auto-accept" }).getByRole("checkbox", { name: /Claude Code/ });
  await off.click();
  await expect(page.getByText("Claude Code asks before every save")).toBeVisible();
  await expect(off).not.toBeChecked();
  await expect(page.getByRole("region", { name: "Auto-accept" }).getByText("Asks before every save.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "Auto-accept" }).getByRole("checkbox", { name: /Claude Code/ })).not.toBeChecked();
  await harnessSave(stack, [{ action: "create", type: "note", title: "Quasar naming", facts: [{ subject: "Idea", value: "Name builds after quasars" }] }], { agent: "claude-code", session: "sess-asked" });
  await page.goto(`${stack.url}/brain/recent`);
  const confirmed = page.getByRole("region", { name: "Recent saves" }).getByRole("listitem").filter({ hasText: "Quasar naming" });
  await expect(confirmed).toContainText("Claude Code, session sess-asked");
  await expect(confirmed).not.toContainText("auto-accepted");

  // Switched on again, as a new Machine starts.
  await page.goto(`${stack.url}/settings`);
  const on = page.getByRole("region", { name: "Auto-accept" }).getByRole("checkbox", { name: /Claude Code/ });
  await on.click();
  await expect(page.getByText("Claude Code saves without asking on this Machine")).toBeVisible();
  await expect(on).toBeChecked();
});

test("consolidation switch: on by default beside the Harness switches, a meeting's change is written without review, and switched off it makes Proposals", async () => {
  const page = await journeys.open("/settings");
  const row = page.locator("[data-consolidation]");
  const box = row.getByRole("checkbox", { name: "Consolidation" });
  await expect(box).toBeChecked();
  await expect(row).toContainText("Writes what it finds in finished sessions and meetings without asking.");

  // On: what Consolidation finds in a meeting is in the Brain straight away, listed in Recent saves.
  const helix = "We agreed the Helix review board meets every Tuesday";
  arriveMeetingCapture(stack, "evidence/captures/2026-11-16-granola-helix-review.md", "Granola 2026-11-16: Helix review", [`[0:05] Alex: ${helix}.`], {
    proposals: [{ item: { action: "create", type: "project", title: "Helix review board", facts: [{ subject: "Meets", value: "Every Tuesday" }] }, reason: "The review agreed a weekly board.", evidence: helix }],
  });
  await expect.poll(() => existsSync(join(stack.dataDir, "memory/projects/helix-review-board.md"))).toBe(true);
  await page.goto(`${stack.url}/brain/recent`);
  await expect(page.getByRole("region", { name: "Recent saves" }).getByRole("listitem").filter({ hasText: "Helix review board" }).first()).toBeVisible();

  // Off: kept across a reload, and the next meeting's change waits for review instead.
  await page.goto(`${stack.url}/settings`);
  await page.locator("[data-consolidation]").getByRole("checkbox", { name: "Consolidation" }).click();
  await expect(page.getByText("Consolidation makes Proposals on this Machine")).toBeVisible();
  await expect(page.locator("[data-consolidation]")).toContainText("Makes Proposals for you to review instead.");
  await page.reload();
  await expect(page.locator("[data-consolidation]").getByRole("checkbox", { name: "Consolidation" })).not.toBeChecked();
  const kestrel = "We agreed the Kestrel review board meets every Thursday";
  arriveMeetingCapture(stack, "evidence/captures/2026-11-16-granola-kestrel-review.md", "Granola 2026-11-16: Kestrel review", [`[0:05] Alex: ${kestrel}.`], {
    proposals: [{ item: { action: "create", type: "project", title: "Kestrel review board", facts: [{ subject: "Meets", value: "Every Thursday" }] }, reason: "The review agreed a weekly board.", evidence: kestrel }],
  });
  await page.goto(`${stack.url}/approvals`);
  const proposal = approvalRow(proposalsGroup(page), "proposal", "Kestrel review board");
  await expect(proposal).toBeVisible();
  expect(existsSync(join(stack.dataDir, "memory/projects/kestrel-review-board.md"))).toBe(false);
  await openApprovalRow(proposal);
  await proposal.getByRole("button", { name: "Reject" }).click();
  await expect(proposal).toHaveAttribute("data-decided", "Rejected");

  // Back on, as the other journeys expect.
  await page.goto(`${stack.url}/settings`);
  await page.locator("[data-consolidation]").getByRole("checkbox", { name: "Consolidation" }).click();
  await expect(page.getByText("Consolidation writes without asking on this Machine")).toBeVisible();
});

test("home: Recently added lists each change written without review with its source, and one click reverts it", async () => {
  const page = await journeys.open("/");
  const hydra = "memory/projects/hydra-rollout.md";
  // The owner confirms this save in the Harness, so it stays off Home.
  await claudeCodeAutoAccept(page, false);
  await harnessSave(stack, [{ action: "create", type: "project", title: "Hydra rollout", facts: [{ subject: "Region", value: "Frankfurt" }] }], { agent: "claude-code", session: "sess-home-1" });
  // These two are written without asking.
  await claudeCodeAutoAccept(page, true);
  await harnessSave(stack, [{ action: "update", path: hydra, facts: [{ subject: "Region", value: "Stockholm", reason: "closer to the users" }] }], { agent: "claude-code", session: "sess-home-2" });
  await harnessSave(stack, [{ action: "create", type: "person", title: "Ines Ortega", facts: [{ subject: "Role", value: "Hydra on-call lead" }] }], { agent: "claude-code", session: "sess-home-2" });

  await page.reload();
  const section = page.getByRole("region", { name: "Recently added" });
  // One line, closed: it says how many changes reached the Brain without review, and opens into them.
  await expect(section.locator("summary")).toHaveText(/^Recently added\s*\d+ changes? written without your review in the last 7 days$/);
  await expect(section.getByRole("listitem")).toHaveCount(0);
  await openRecentlyAdded(page);
  const entries = section.getByRole("listitem");
  await expect(entries.first()).toContainText("Ines Ortega");
  await expect(entries.first()).toContainText("Created the note");
  await expect(entries.filter({ hasText: "Created the note" }).filter({ hasText: "Hydra rollout" })).toHaveCount(0);
  const region = entries.filter({ hasText: "Stockholm" });
  await expect(region).toContainText("Region");
  await expect(region.locator("del")).toHaveText("Frankfurt");
  await expect(region.locator("ins")).toHaveText("Stockholm");
  await expect(region).toContainText("closer to the users");
  await expect(region).toContainText("Claude Code, session sess-home-2");
  await expect(region.locator("time")).toBeVisible();

  await region.getByRole("button", { name: "Revert" }).click();
  await expect(page.getByText("Reverted. The revert is listed as a change of its own.")).toBeVisible();
  await expect(region).toContainText("reverted");
  await expect(region.getByRole("button", { name: "Revert" })).toHaveCount(0);
  // The revert is the owner's own change, so it is not listed.
  await expect(entries.filter({ hasText: "Revert in the Dashboard" })).toHaveCount(0);
  expect(readFileSync(join(stack.dataDir, hydra), "utf8")).toMatch(/- \*\*Region\*\* \(\d{4}-\d{2}-\d{2}\): Frankfurt/);
});

test("home: a change Consolidation wrote from a meeting shows beside an auto-accepted save, each with its source, and reverts in one click", async () => {
  const page = await journeys.open("/");
  const lyra = "memory/projects/lyra-launch-review.md";
  const said = "We agreed the Lyra launch review happens on Wednesdays";
  arriveMeetingCapture(stack, "evidence/captures/2026-11-17-granola-lyra-review.md", "Granola 2026-11-17: Lyra review", [`[0:07] Alex: ${said}.`], {
    proposals: [{ item: { action: "create", type: "project", title: "Lyra launch review", facts: [{ subject: "Meets", value: "Wednesdays" }] }, reason: "The review agreed its weekly slot.", evidence: said }],
  });
  await expect.poll(() => existsSync(join(stack.dataDir, lyra))).toBe(true);
  await harnessSave(stack, [{ action: "create", type: "person", title: "Odile Marchand", facts: [{ subject: "Role", value: "Lyra launch manager" }] }], { agent: "claude-code", session: "sess-lyra" });

  await page.reload();
  await openRecentlyAdded(page);
  const entries = page.getByRole("region", { name: "Recently added" }).getByRole("listitem");
  const saved = entries.filter({ hasText: "Odile Marchand" });
  const consolidated = entries.filter({ hasText: "Lyra launch review" });
  await expect(saved).toContainText("Claude Code, session sess-lyra");
  await expect(saved).not.toContainText("consolidated");
  await expect(consolidated).toContainText("Created the note");
  await expect(consolidated).toContainText("Consolidation of meeting “Granola 2026-11-17: Lyra review”");
  await expect(consolidated).toContainText("consolidated");

  await consolidated.getByRole("button", { name: "Revert" }).click();
  await expect(page.getByText("Reverted. The revert is listed as a change of its own.")).toBeVisible();
  await expect(consolidated).toContainText("reverted");
  expect(existsSync(join(stack.dataDir, lyra))).toBe(false);
});

test("home: an entry leaves Recently added when it turns 7 days old, while Home stays open", async () => {
  const DAY = 86_400_000;
  for (const p of journeys.context.pages()) await p.close();
  const page = await journeys.newPage();
  await page.clock.install();
  // The service's clock cannot be moved, so the 7-day window it applies is applied here to its answer, at the page's time.
  let movedOn = 0;
  await page.route("**/api/v1/memory/recent-changes?unreviewed=1", async (route) => {
    const response = await route.fetch();
    const { changes } = (await response.json()) as { changes: Array<{ at: string }> };
    const now = Date.now() + movedOn;
    await route.fulfill({ response, json: { changes: changes.filter((c) => Date.parse(c.at) >= now - 7 * DAY) } });
  });
  await page.goto(`${stack.url}/`);
  const section = page.getByRole("region", { name: "Recently added" });
  await openRecentlyAdded(page);
  await expect(section.getByRole("listitem").first()).toBeVisible();

  // A week passes with Home open, and nothing else changes in the Brain.
  movedOn = 7 * DAY;
  await page.clock.fastForward(movedOn);
  await expect(section).toContainText("Nothing was written without your review in the last 7 days.");
  await expect(section.getByRole("listitem")).toHaveCount(0);
  await page.close();
});

test("no unresolved console errors across journeys", () => {
  expect(journeys.consoleErrors).toEqual([]);
});
