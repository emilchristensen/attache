/** Captures every view in light, dark and narrow layouts for visual review (test-results/screens). */
import { test, expect } from "@playwright/test";
import { buildAll, startStack, type Stack } from "./stack.ts";

let stack: Stack;
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  buildAll();
  stack = await startStack({ port: 7613 });
});
test.afterAll(() => stack?.stop());

test("screens", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(stack.pairUrl());
  await page.getByRole("textbox", { name: /Data folder/ }).fill(stack.dataDir);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByRole("textbox", { name: "Folder to import" }).fill(stack.vaultDir);
  await page.getByRole("button", { name: "Preview import" }).click();
  await page.screenshot({ path: "test-results/screens/setup-folder.png", fullPage: true });
  await page.getByRole("button", { name: "Use this folder" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  const gh = page.locator('[data-connection="github"]');
  await gh.getByRole("button", { name: "Set up" }).click();
  await page.screenshot({ path: "test-results/screens/setup-connections.png", fullPage: true });
  await gh.getByRole("textbox", { name: "Token" }).fill("ghp_fixturetokenfixturetoken12345678");
  await gh.getByRole("button", { name: "Connect" }).click();
  await expect(gh.getByText("connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  const model = page.locator('[data-connection="model"]');
  await model.getByRole("button", { name: "Set up" }).click();
  await model.getByRole("combobox", { name: "How to connect" }).selectOption("openai-compatible");
  await model.getByRole("textbox", { name: "Base URL" }).fill(`${stack.fixtureUrl}/model`);
  await model.getByRole("textbox", { name: "Model" }).fill("fixture-model");
  await model.getByRole("button", { name: "Connect" }).click();
  await expect(model.getByText("connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByText(/Review acme\/web#42/)).toBeVisible({ timeout: 20_000 });
  await page.getByRole("textbox", { name: "Message Jarvis" }).fill("When is the cutover plan due for the Orion migration?");
  await page.keyboard.press("Enter");
  await expect(page.locator(".msg.assistant").last()).toHaveAttribute("data-status", "complete");
  await page.locator("article.item", { hasText: "Review acme/web#42" }).getByRole("button", { name: "Prepare draft" }).click();
  await page.getByRole("button", { name: "Prepare briefing" }).click();
  await page.waitForTimeout(1500);
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const [name, path] of [["home", "/"], ["memory", "/memory?tab=person"], ["drafts", "/drafts"], ["jobs", "/jobs"], ["connections", "/connections"], ["settings", "/settings"]] as const) {
      await page.goto(`${stack.url}${path}`);
      await page.waitForTimeout(600);
      await page.screenshot({ path: `test-results/screens/${scheme}-${name}.png`, fullPage: false });
    }
    // Below the fold of the settings screenshot.
    await page.locator(".card", { has: page.getByRole("heading", { name: "This Machine" }) }).screenshot({ path: `test-results/screens/${scheme}-settings-machine.png` });
  }
  await page.goto(stack.url);
  await page.locator(".msg.assistant button.cite").first().click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: "test-results/screens/dark-evidence.png" });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [name, path] of [["home", "/"], ["drafts", "/drafts"], ["settings", "/settings"]] as const) {
    await page.goto(`${stack.url}${path}`);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `test-results/screens/narrow-${name}.png`, fullPage: false });
  }
});
