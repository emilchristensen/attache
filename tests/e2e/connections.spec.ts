/**
 * The Connections page (#31 of spec #14): rows in four groups with account, permission and last read in their own
 * columns, opening in place into everything the card had; small tiles for what is not set up; and "Needs you" first,
 * already open, when a Connection needs sign-in, where Home's Reconnect lands. Driven through the Dashboard against the
 * real bundled service and the TEST-ONLY fixtures; it sets itself up through the API, so it runs on its own.
 */
import { test, expect, type Page } from "@playwright/test";
import { api, JourneyBrowser } from "./browser.ts";
import { connection, connectionToggle, openConnection } from "./connections.ts";
import { buildAll, startStack, type Stack } from "./stack.ts";

let stack: Stack;
let journeys: JourneyBrowser;

/** The GitHub token saved at setup; the fixture GitHub can revoke it. */
const TOKEN = "ghp_fixturetokenfixturetoken12345678";
/** The token the owner types when they reconnect: a different one, as a new token from GitHub would be. */
const NEW_TOKEN = "ghp_renewedrenewedrenewed0987654321";

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  buildAll();
  stack = await startStack();
  journeys = await JourneyBrowser.start(browser, stack.url);
  // A finished setup with GitHub read once, the model and Claude Code; everything else is not set up.
  const page = await journeys.newPage();
  await page.goto(stack.pairUrl());
  await expect(page.getByRole("heading", { name: "Where should Attache keep your knowledge?" })).toBeVisible();
  await api(page, "POST", "/setup/data-folder", { path: stack.dataDir });
  await api(page, "POST", "/setup/identity", { name: "Test User", email: "alex@example.com", confirm: true });
  await api(page, "POST", "/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${stack.fixtureUrl}/model`, model: "fixture-model" } });
  await api(page, "POST", "/connections/github/configure", { method: "token", fields: { token: TOKEN } });
  await api(page, "POST", "/connections/claude-code/configure", { method: "hooks", fields: {} });
  await api(page, "POST", "/setup/complete");
  await api(page, "POST", "/connections/github/refresh");
  await expect.poll(async () => (await api<Array<{ id: string; lastReadAt: string | null }>>(page, "GET", "/connections")).find((c) => c.id === "github")?.lastReadAt ?? null).not.toBeNull();
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

const groupHeadings = (page: Page) => page.locator(".connection-group h2");

async function revokeGithubToken(token: string, revoke: boolean) {
  const res = await fetch(`${stack.fixtureUrl}/__control/github-token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, revoke }) });
  expect(res.ok).toBe(true);
}

/** The left edge and width of an element, to compare columns. */
async function box(page: Page, selector: string) {
  const b = await page.locator(selector).first().boundingBox();
  if (!b) throw new Error(`${selector} is not shown`);
  return b;
}

test("groups: the Reader first, then rows in Notes, Work sources, Harnesses and Model with account, permission and last read in their own columns, and tiles for what is not set up", async () => {
  const page = await journeys.open("/connections");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connections");
  // The Reader and its last Source refresh come before any group.
  const reader = page.locator(".page .reader-line");
  await expect(reader).toContainText("This Machine runs Source refresh and briefings. Last Source refresh");
  await expect(groupHeadings(page)).toHaveText(["Notes", "Work sources", "Harnesses", "Model"]);
  expect((await reader.boundingBox())!.y).toBeLessThan((await groupHeadings(page).first().boundingBox())!.y);

  // GitHub's row: its account, what Attache may read and write, and when it was last read, each in its own column.
  const gh = connection(page, "github");
  await expect(gh.locator(".connection-account")).toHaveText("Account: alex");
  await expect(gh.locator(".connection-permission")).toHaveText("Reads pull requests requesting my review and my open pull requestsWrites nothing");
  await expect(gh.locator(".connection-last time")).toBeVisible();
  // A Connection that works carries no state word.
  await expect(page.locator(".page [data-connection-state]")).toHaveCount(0);
  const work = '[data-group="work"]';
  const permission = await box(page, `${work} .connection-row .connection-permission`);
  const last = await box(page, `${work} .connection-row .connection-last`);
  expect(last.x, "last read is a column of its own, right of the permission").toBeGreaterThanOrEqual(permission.x + permission.width);
  // Each column's name stands above it.
  const heads = page.locator(`${work} .connection-col`);
  await expect(heads).toHaveText(["Account", "May read and write", "Last read"]);
  expect(Math.abs((await heads.nth(1).boundingBox())!.x - permission.x)).toBeLessThanOrEqual(1);
  expect(Math.abs((await heads.nth(2).boundingBox())!.x - last.x)).toBeLessThanOrEqual(1);
  await expect(page.locator('[data-group="harnesses"] .connection-col').last()).toHaveText("Last answered");
  await expect(connection(page, "claude-code").locator(".connection-permission")).toHaveText("Reads the BrainWrites to the Brain");

  // What is not set up is a small tile under its group, never a row.
  const tiles = page.locator(`${work} .connection-tile`);
  await expect(tiles.locator(".connection-tile-name")).toHaveText(["Jira", "Confluence", "Slack", "Gmail", "Google Calendar"]);
  await expect(tiles.locator(".connection-tile-meta")).toHaveText(Array(5).fill("Not set up"));
  const tile = await box(page, `${work} .connection-tile`);
  const row = await box(page, `${work} .connection-row`);
  expect(tile.width).toBeLessThan(row.width / 3);
  expect(tile.height).toBeLessThanOrEqual(64);
  await expect(page.locator('[data-group="harnesses"] .connection-tile-name')).toHaveText(["Codex", "Antigravity", "Claude Desktop"]);
  // Nothing needs sign-in, so there is no Needs you and nothing starts open.
  await expect(page.locator('[data-group="needs_you"]')).toHaveCount(0);
  await expect(page.locator('.page [aria-expanded="true"]')).toHaveCount(0);
});

test("a row opens in place with every action the card had: Test, Refresh now, what it reads, write permissions, Reconfigure and Disconnect", async () => {
  const page = await journeys.open("/connections");
  const gh = connection(page, "github");
  const toggle = connectionToggle(gh);
  // The row opens by keyboard, from its name.
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const detail = gh.locator(".connection-detail");
  await expect(detail).toContainText("Pull requests waiting for your review");
  await expect(detail).toContainText("Last success");
  // The last Source refresh, scope by scope.
  await expect(detail).toContainText("PRs requesting my review: complete");

  await detail.getByRole("button", { name: "Test", exact: true }).click();
  await expect(detail).toContainText("Test: Signed in as alex");
  await detail.getByRole("button", { name: "Refresh now" }).click();
  await expect(page.getByText("Refresh started")).toBeVisible();

  // What Attache reads, changed in place; the row's permission column follows.
  await detail.getByText("Change what Attache reads").click();
  await detail.getByRole("checkbox", { name: "Issues assigned to me" }).check();
  await detail.getByRole("button", { name: "Save scopes" }).click();
  await expect(gh.locator(".connection-permission")).toContainText("Reads pull requests requesting my review, my open pull requests and issues assigned to me");

  // Writing is allowed separately, with its own confirmation.
  await detail.getByText(/^Write permissions/).click();
  await detail.getByRole("checkbox", { name: /Post a comment/ }).check();
  await detail.getByRole("checkbox", { name: /I understand/ }).check();
  await detail.getByRole("button", { name: "Save write permissions" }).click();
  await expect(gh.locator(".connection-permission")).toContainText("Writes post a comment on a pull request or issue");
  await detail.getByRole("checkbox", { name: /Post a comment/ }).uncheck();
  await detail.getByRole("button", { name: "Save write permissions" }).click();
  await expect(gh.locator(".connection-permission")).toContainText("Writes nothing");

  await detail.getByRole("button", { name: "Reconfigure" }).click();
  await expect(detail.getByRole("textbox", { name: "Token" })).toBeVisible();
  // A method chosen and then cancelled is forgotten: Reconfigure starts again from what was saved.
  await detail.getByRole("combobox", { name: "How to connect" }).selectOption("gh-cli");
  await detail.getByRole("button", { name: "Cancel" }).click();
  await expect(detail.getByRole("textbox", { name: "Token" })).toHaveCount(0);
  await detail.getByRole("button", { name: "Reconfigure" }).click();
  await expect(detail.getByRole("combobox", { name: "How to connect" })).toHaveValue("token");
  await detail.getByRole("button", { name: "Cancel" }).click();

  await detail.getByRole("button", { name: "Disconnect…" }).click();
  const confirm = detail.getByRole("alertdialog", { name: "Disconnect" });
  await expect(confirm).toContainText("Disconnect GitHub?");
  await expect(confirm.getByRole("button", { name: "Disconnect, keep data" })).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toHaveCount(0);

  // It closes again from its name, and stays as the owner left it while live answers arrive.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(detail).toBeHidden();
});

test("a tile opens in place across its group into the setup form, and the Notes group imports a folder", async () => {
  const page = await journeys.open("/connections");
  const gmail = await openConnection(page, "gmail");
  await expect(gmail.getByRole("button", { name: "Connect" })).toBeVisible();
  const group = await box(page, '[data-group="work"] .connection-tiles');
  const open = (await gmail.boundingBox())!;
  expect(Math.abs(open.width - group.width)).toBeLessThanOrEqual(1);
  await connectionToggle(gmail).click();
  await expect(gmail.getByRole("button", { name: "Connect" })).toBeHidden();

  // Connecting from a tile makes it a row in its group, still open, and the connect test's result stays with it.
  const slack = await openConnection(page, "slack");
  await slack.getByRole("button", { name: "Connect" }).click();
  await expect(page.locator('[data-group="work"] .connection-row[data-connection="slack"]')).toBeVisible({ timeout: 30_000 });
  await expect(slack.locator(".connection-detail")).toContainText("Test: Slack answered through claude.ai");

  // Importing a folder: preview first, then import, read-only.
  await page.getByRole("button", { name: /^Import a folder/ }).click();
  await page.getByRole("textbox", { name: "Folder path" }).fill(stack.vaultDir);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByText(/^Reads 2 Markdown files · changes 0 files$/)).toBeVisible();
  await page.getByRole("button", { name: "Import", exact: true }).click();
  await expect(page.getByText("Import started")).toBeVisible();
  // The imported folder becomes a row in Notes, which reads it and writes nothing there.
  const notes = page.locator('[data-group="notes"] .connection-row');
  await expect(notes).toHaveCount(2);
  await expect(notes.last().locator(".connection-permission")).toContainText("Writes nothing");
});

test("Needs you: a revoked token signs GitHub out, Home's Reconnect opens its row first in Needs you with the token field ready, and a new token puts it back", async () => {
  // Signed out while the page is open: the closed row moves to Needs you and opens there by itself.
  const page = await journeys.open("/connections");
  await expect(connectionToggle(connection(page, "github"))).toHaveAttribute("aria-expanded", "false");
  await revokeGithubToken(TOKEN, true);
  await api(page, "POST", "/connections/github/refresh");
  await expect.poll(async () => (await api<Array<{ id: string; status: string }>>(page, "GET", "/connections")).find((c) => c.id === "github")?.status).toBe("needs_auth");
  await expect(connectionToggle(page.locator('[data-group="needs_you"] [data-connection="github"]'))).toHaveAttribute("aria-expanded", "true");
  await page.goto(`${stack.url}/`);

  // Home: one amber sign-in row; its Reconnect needs a new token, so it opens GitHub's own row on Connections.
  const area = page.getByRole("status", { name: "Connections" });
  const signIn = area.locator('.conn-row[data-state="sign_in"]');
  await expect(signIn.locator(".conn-row-line")).toHaveText("GitHub · Sign-in needed · Reviews may be missing");
  await signIn.getByRole("button", { name: "Reconnect" }).click();
  await expect(page).toHaveURL(`${stack.url}/connections?open=github`);

  // Needs you comes first, already open, and holds GitHub instead of Work sources.
  await expect(groupHeadings(page)).toHaveText(["Needs you", "Notes", "Work sources", "Harnesses", "Model"]);
  const needsYou = page.locator('[data-group="needs_you"]');
  const gh = needsYou.locator('[data-connection="github"]');
  await expect(connectionToggle(gh)).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('[data-group="work"] [data-connection="github"]')).toHaveCount(0);
  await expect(gh.locator('[data-connection-state="sign_in"]')).toHaveText("Sign-in needed");
  await expect(groupHeadings(page).first()).toBeInViewport();
  // The keyboard is in the token field, ready for the new token.
  const token = gh.getByRole("textbox", { name: "Token" });
  await expect(token).toBeFocused();
  await expect(gh.locator(".connection-detail")).toContainText("Sign-in expired or rejected");

  // A plain visit opens Needs you too, with the form for the new token.
  await page.goto(`${stack.url}/connections`);
  await expect(connectionToggle(gh)).toHaveAttribute("aria-expanded", "true");
  await expect(token).toBeVisible();
  await expect(page.locator('.page [aria-expanded="true"]')).toHaveCount(1);
  await expect(page.locator(".masthead-nav").getByRole("link", { name: /^Connections/ })).toHaveAccessibleName("Connections, 1 sign-in needed");

  // A new token: GitHub works again and goes back to Work sources, and Needs you goes.
  await token.fill(NEW_TOKEN);
  await gh.getByRole("button", { name: "Save and test" }).click();
  await expect(page.locator('[data-group="work"] [data-connection="github"]')).toBeVisible();
  await expect(needsYou).toHaveCount(0);
  await expect(page.locator(".masthead-nav").getByRole("link", { name: /^Connections/ })).toHaveAccessibleName("Connections");
  await revokeGithubToken(TOKEN, false);
});

test("captures: the page in light, dark and narrow, with a row open and with a sign-in in Needs you", async () => {
  const page = await journeys.open("/connections");
  const shoot = async (name: string) => {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(250);
      await page.screenshot({ path: `test-results/screens/${scheme}-connections-${name}.png` });
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(250);
    await page.screenshot({ path: `test-results/screens/narrow-connections-${name}.png` });
    await page.setViewportSize({ width: 1360, height: 900 });
  };
  await expect(groupHeadings(page).first()).toBeVisible();
  await shoot("groups");
  await openConnection(page, "github");
  await shoot("row-open");
  // A signed-out GitHub, from the real answer with its status changed, so nothing else moves.
  await page.route("**/api/v1/capabilities", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { connections: Array<{ id: string }> };
    body.connections = body.connections.map((c) => (c.id === "github" ? { ...c, status: "needs_auth", lastError: "Bad credentials" } : c));
    await route.fulfill({ response: res, json: body });
  });
  await page.goto(`${stack.url}/connections?open=github`);
  await expect(page.locator('[data-group="needs_you"] [data-connection="github"]')).toBeVisible();
  await shoot("needs-you");
  // At 320 px nothing scrolls sideways.
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => [document.documentElement.scrollWidth <= innerWidth, document.querySelector(".page")!.scrollWidth <= document.querySelector(".page")!.clientWidth])).toEqual([true, true]);
  // The state word stays on one line, and a tile's words never run under its chevron.
  expect((await page.locator("[data-connection-state]").first().boundingBox())!.height).toBeLessThanOrEqual(20);
  const tile = page.locator("[data-import-folder] > button");
  const words = await tile.locator(".connection-tile-meta").boundingBox();
  const chevron = await tile.locator(".connection-chevron").boundingBox();
  expect(words!.x + words!.width).toBeLessThanOrEqual(chevron!.x);
  await page.screenshot({ path: "test-results/screens/narrow-320-connections-needs-you.png" });
  await page.unroute("**/api/v1/capabilities");

  // Two sign-ins on a phone: a link to the second lands on it, in view, below the first one's open form.
  await page.route("**/api/v1/capabilities", async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { connections: Array<{ id: string }> };
    body.connections = body.connections.map((c) => (c.id === "github" || c.id === "model" ? { ...c, status: "needs_auth", lastError: "Signed out" } : c));
    await route.fulfill({ response: res, json: body });
  });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`${stack.url}/connections?open=model`);
  const model = page.locator('[data-group="needs_you"] [data-connection="model"]');
  await expect(model.locator(":focus")).toHaveCount(1);
  await expect(model.locator(":focus")).toBeInViewport();
  // Going Back to a link for a row that is closed on the page in between opens it again, with the keyboard in it.
  await page.goto(`${stack.url}/connections?open=claude-code`);
  const claudeCode = connection(page, "claude-code");
  await expect(claudeCode.locator(":focus")).toHaveCount(1);
  // In the page itself: the bottom bar's More sheet leads to plain Connections, and Back returns, with no reload.
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("dialog", { name: "More" }).getByRole("link", { name: /^Connections/ }).click();
  await expect(page).toHaveURL(`${stack.url}/connections`);
  await expect(connectionToggle(claudeCode)).toHaveAttribute("aria-expanded", "false");
  await page.goBack();
  await expect(page).toHaveURL(`${stack.url}/connections?open=claude-code`);
  await expect(connectionToggle(claudeCode)).toHaveAttribute("aria-expanded", "true");
  await expect(claudeCode.locator(":focus")).toHaveCount(1);
  await page.unroute("**/api/v1/capabilities");
  await page.setViewportSize({ width: 1360, height: 900 });
});

test("no unresolved console errors across the Connections journeys", () => {
  expect(journeys.consoleErrors).toEqual([]);
});
