/**
 * Settings (#32 of spec #14): a section list in four groups beside the one section the address names, every setting
 * and action in exactly one section, and feature switches that only speak up about a problem. Driven through the
 * Dashboard against the real bundled service and the TEST-ONLY fixtures; set up through the API, so it runs on its own.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import type { FeatureStatus } from "@attache/contracts";
import { api, JourneyBrowser } from "./browser.ts";
import { buildAll, startStack, type Stack } from "./stack.ts";

let stack: Stack;
let journeys: JourneyBrowser;

test.describe.configure({ mode: "serial" });

/** The section list as the owner reads it: each group's name, then its sections, in order. */
const GROUPS = [
  ["Attache", ["Features", "Schedules and notifications", "Identity"]],
  ["Brain", ["Saving and review", "Meaning-based search", "Backup and export"]],
  ["Machines", ["Machines and Replication", "Paired clients"]],
  ["Service", ["Service health"]],
] as const;

const SECTIONS: Record<string, string> = {
  features: "Features",
  schedules: "Schedules and notifications",
  identity: "Identity",
  saving: "Saving and review",
  "meaning-search": "Meaning-based search",
  backup: "Backup and export",
  machines: "Machines and Replication",
  clients: "Paired clients",
  service: "Service health",
};

type Role = "button" | "checkbox" | "textbox" | "spinbutton" | "tab" | "combobox";

/** Every setting and action Settings has, and the one section that holds it. */
const INVENTORY: ReadonlyArray<[section: string, role: Role, name: string | RegExp]> = [
  ["features", "checkbox", /^Attention and briefings/],
  ["features", "checkbox", /^Drafts and approvals/],
  ["schedules", "spinbutton", "Refresh sources every (minutes)"],
  ["schedules", "checkbox", "Prepare a daily briefing"],
  ["schedules", "checkbox", "Desktop notification for new urgent items"],
  ["schedules", "button", "Save"],
  ["identity", "textbox", "Email"],
  ["identity", "checkbox", "I want to change my protected identity record"],
  ["identity", "button", "Save identity"],
  ["saving", "checkbox", "Consolidation"],
  ["meaning-search", "button", /^Download model/],
  ["backup", "button", "Create backup now"],
  ["machines", "button", "Rename"],
  ["machines", "tab", "Start with this Brain"],
  ["machines", "tab", "Join another Machine"],
  ["machines", "button", "Set up Replication"],
  ["clients", "button", "Create pairing code"],
  ["service", "button", "Rebuild index"],
];

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
  await page.close();
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

const sectionList = (page: Page) => page.getByRole("navigation", { name: "Settings sections" });
/** The one section on screen. */
const shown = (page: Page) => page.locator("[data-settings-section]");
const sectionHeading = (page: Page) => shown(page).getByRole("heading", { level: 2 }).first();

async function expectSection(page: Page, id: string) {
  await expect(shown(page)).toHaveAttribute("data-settings-section", id);
  await expect(sectionHeading(page)).toHaveText(SECTIONS[id]!);
  await expect(shown(page)).toHaveCount(1);
}

test("sections: a list in four groups beside one section; each section has its own address and browser Back goes through them", async () => {
  const page = await journeys.open("/settings");
  await expect(page.getByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
  const list = sectionList(page);
  for (const [group, sections] of GROUPS) {
    const g = list.getByRole("group", { name: group });
    await expect(g.getByRole("link")).toHaveText([...sections]);
  }
  // Settings itself opens the first section, marked as the current one.
  await expectSection(page, "features");
  await expect(list.getByRole("link", { name: "Features" })).toHaveAttribute("aria-current", "page");
  // The list sits beside the section, to its left.
  const listBox = (await list.boundingBox())!;
  const sectionBox = (await shown(page).boundingBox())!;
  expect(listBox.x + listBox.width).toBeLessThanOrEqual(sectionBox.x);

  await list.getByRole("link", { name: "Identity" }).click();
  await expect(page).toHaveURL(`${stack.url}/settings/identity`);
  await expectSection(page, "identity");
  await expect(list.getByRole("link", { name: "Identity" })).toHaveAttribute("aria-current", "page");
  await expect(list.getByRole("link", { name: "Features" })).not.toHaveAttribute("aria-current", /.*/);
  // Chosen from the list, focus stays on the list, so the next section is one key away.
  await expect(list.getByRole("link", { name: "Identity" })).toBeFocused();

  await list.getByRole("link", { name: "Service health" }).click();
  await expect(page).toHaveURL(`${stack.url}/settings/service`);
  await expectSection(page, "service");

  await page.goBack();
  await expect(page).toHaveURL(`${stack.url}/settings/identity`);
  await expectSection(page, "identity");
  await page.goBack();
  await expect(page).toHaveURL(`${stack.url}/settings`);
  await expectSection(page, "features");
  await page.goForward();
  await expectSection(page, "identity");

  // Each address opens its section directly, after a reload too; an address with no section says so.
  for (const id of Object.keys(SECTIONS)) {
    await page.goto(`${stack.url}/settings/${id}`);
    await expectSection(page, id);
  }
  await page.reload();
  await expectSection(page, "service");
  await page.goto(`${stack.url}/settings/nothing-here`);
  await expect(shown(page)).toHaveCount(0);
  await expect(page.getByText("There is no Settings section at this address.")).toBeVisible();
  await sectionList(page).getByRole("link", { name: "Paired clients" }).click();
  await expectSection(page, "clients");
});

/** A control in the section on screen, by its whole name. */
const control = (page: Page, role: Role, name: string | RegExp) => shown(page).getByRole(role, { name, exact: typeof name === "string" });

test("sections: every setting and action is in exactly one section", async () => {
  const page = await journeys.open("/settings");
  for (const id of Object.keys(SECTIONS)) {
    await page.goto(`${stack.url}/settings/${id}`);
    await expectSection(page, id);
    // Each part loads on its own; wait for the ones this section holds.
    for (const [section, role, name] of INVENTORY.filter(([s]) => s === id)) await expect(control(page, role, name), `${name} in ${section}`).toHaveCount(1);
    for (const [section, role, name] of INVENTORY.filter(([s]) => s !== id)) await expect(control(page, role, name), `${name} (of ${section}) not in ${id}`).toHaveCount(0);
  }
  // What the old page showed beside the controls is still somewhere: the secret store in Service health, this Machine's id beside its name.
  await page.goto(`${stack.url}/settings/service`);
  await expect(shown(page).locator("[data-credential-store]")).toBeVisible();
  await page.goto(`${stack.url}/settings/machines`);
  await expect(shown(page).getByRole("region", { name: "Replication" })).toBeVisible();
  await expect(shown(page).locator("[data-machine-name]")).not.toHaveValue("");
});

test("identity: a change still asks for confirmation, and the confirmation is asked again for the next change", async () => {
  const page = await journeys.open("/settings/identity");
  const section = shown(page);
  const save = section.getByRole("button", { name: "Save identity" });
  const confirm = section.getByRole("checkbox", { name: "I want to change my protected identity record" });
  await expect(section.getByRole("textbox", { name: "Name" })).toHaveValue("Test User");
  await section.getByRole("textbox", { name: "Name" }).fill("Alex Example");
  await expect(save).toBeDisabled();
  await confirm.check();
  await save.click();
  await expect(page.getByText("Identity saved")).toBeVisible();
  await expect(confirm).not.toBeChecked();
  await expect(save).toBeDisabled();
  const { config } = await api<{ config: { identity: { name: string } } }>(page, "GET", "/config");
  expect(config.identity.name).toBe("Alex Example");
});

/** The switch row of a feature. */
const featureRow = (page: Page, id: string): Locator => shown(page).locator(`[data-feature="${id}"]`);

test("features: a switch names only a problem, with its reason; a healthy or switched-off feature is quiet", async () => {
  const page = await journeys.open("/settings/features");
  const { features } = await api<{ features: FeatureStatus[] }>(page, "GET", "/capabilities");
  const problems = features.filter((f) => f.enabled && ["needs_setup", "partial", "unavailable"].includes(f.readiness));
  const quiet = features.filter((f) => !problems.includes(f));
  // A fresh install with no Connection has at least one feature waiting for its setup.
  expect(problems.length).toBeGreaterThan(0);
  const words = { needs_setup: "needs setup", partial: "partly working", unavailable: "unavailable" } as Record<string, string>;
  for (const f of problems) {
    const row = featureRow(page, f.id);
    await expect(row.locator("[data-feature-problem]")).toHaveText(words[f.readiness]!);
    if (f.reason) await expect(row).toContainText(f.reason);
  }
  for (const f of quiet) {
    const row = featureRow(page, f.id);
    await expect(row).toBeVisible();
    await expect(row.locator("[data-feature-problem]")).toHaveCount(0);
    for (const word of ["ready", "disabled", "needs setup", "partly working", "unavailable"]) await expect(row.getByText(word, { exact: true })).toHaveCount(0);
    if (f.reason) await expect(row).not.toContainText(f.reason);
  }
});

test("narrow: Settings opens on the section list; a section fills the screen with a way back to the list, and Back works", async () => {
  const page = await journeys.open("/settings");
  await page.setViewportSize({ width: 390, height: 844 });
  const list = sectionList(page);
  await expect(list).toBeVisible();
  await expect(shown(page)).toBeHidden();
  for (const [group] of GROUPS) await expect(list.getByRole("group", { name: group })).toBeVisible();
  await list.getByRole("link", { name: "Paired clients" }).click();
  await expect(page).toHaveURL(`${stack.url}/settings/clients`);
  await expect(shown(page)).toBeVisible();
  await expect(sectionHeading(page)).toHaveText("Paired clients");
  await expect(list).toBeHidden();
  // Focus goes to the section, since the list it was on is gone.
  await expect(shown(page)).toBeFocused();
  const back = page.getByRole("link", { name: "All settings" });
  await expect(back).toBeVisible();
  await page.goBack();
  await expect(list).toBeVisible();
  await expect(shown(page)).toBeHidden();
  await list.getByRole("link", { name: "Backup and export" }).click();
  await back.click();
  await expect(page).toHaveURL(`${stack.url}/settings`);
  await expect(list).toBeVisible();
  // Nothing is wider than the window.
  for (const id of Object.keys(SECTIONS)) {
    await page.goto(`${stack.url}/settings/${id}`);
    await expectSection(page, id);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${id} fits 390 px`).toBeLessThanOrEqual(0);
  }
  await page.setViewportSize({ width: 1360, height: 900 });
});

test("settings captures: every section, light, dark and narrow", async () => {
  const page = await journeys.open("/settings");
  const shots = "test-results/screens";
  for (const [scheme, viewport] of [["light", { width: 1280, height: 800 }], ["dark", { width: 1280, height: 800 }], ["narrow", { width: 390, height: 844 }]] as const) {
    await page.emulateMedia({ colorScheme: scheme === "dark" ? "dark" : "light" });
    await page.setViewportSize(viewport);
    if (scheme === "narrow") {
      await page.goto(`${stack.url}/settings`);
      await expect(sectionList(page)).toBeVisible();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${shots}/narrow-settings-list.png` });
    }
    for (const id of Object.keys(SECTIONS)) {
      await page.goto(`${stack.url}/settings/${id}`);
      await expectSection(page, id);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${shots}/${scheme}-settings-${id}.png` });
    }
  }
  expect(journeys.consoleErrors).toEqual([]);
});
