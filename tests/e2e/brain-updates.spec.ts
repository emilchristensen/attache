/**
 * Changes reach the Brain without review (ADR 0004): auto-accept per Harness,
 * the Consolidation switch, and Home's Recently added, driven through the
 * Dashboard against the real bundled service and the TEST-ONLY fixtures.
 */
import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { api, JourneyBrowser } from "./browser.ts";
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
  await page.goto(`${stack.url}/memory`);
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
  await page.goto(`${stack.url}/memory`);
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
  await page.goto(`${stack.url}/memory`);
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
  await page.goto(`${stack.url}/memory`);
  const proposal = page.getByRole("region", { name: /Memory changes to review/ }).locator("[data-proposal]").filter({ hasText: "Kestrel review board" });
  await expect(proposal).toBeVisible();
  expect(existsSync(join(stack.dataDir, "memory/projects/kestrel-review-board.md"))).toBe(false);
  await proposal.getByRole("button", { name: "Reject" }).click();
  await expect(proposal).toHaveCount(0);

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
