/**
 * Loads the BUILT plugin into the real desktop Obsidian app with a temporary
 * vault and an isolated Obsidian profile (CFFIXED_USER_HOME), so the user's own
 * Obsidian, vaults and settings are never touched. Requires /Applications/Obsidian.app.
 */
import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, startStack, makeVault, type Stack } from "./stack.ts";

const OBSIDIAN = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const USER_OBSIDIAN_JSON = join(homedir(), "Library/Application Support/obsidian/obsidian.json");
const hash = (f: string) => (existsSync(f) ? createHash("sha256").update(readFileSync(f)).digest("hex") : "absent");

let stack: Stack;
let obsidian: ChildProcess | null = null;
let browser: Browser;
let page: Page;
let token: string;
let vault: string;
const userHashBefore = hash(USER_OBSIDIAN_JSON);

test.describe.configure({ mode: "serial" });
test.skip(!existsSync(OBSIDIAN), "Obsidian desktop is not installed on this host (blocked validation, not a pass)");

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`${stack.url}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-jarvis-client": "1" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return r.json();
}

test.beforeAll(async () => {
  execFileSync(process.execPath, [join(ROOT, "apps/service/build.mjs")], { stdio: "ignore" });
  execFileSync(process.execPath, [join(ROOT, "apps/obsidian/build.mjs")], { stdio: "ignore" });
  stack = await startStack({ port: 7611 });
  const code = new URL(stack.pairUrl()).hash.replace("#code=", "");
  token = (await (await fetch(`${stack.url}/api/v1/pair`, { method: "POST", headers: { "content-type": "application/json", "x-jarvis-client": "1" }, body: JSON.stringify({ code, kind: "cli", clientName: "test-driver" }) })).json()).token;
  // The Obsidian test vault is a separate synthetic folder, imported read-only into Jarvis.
  vault = join(mkdtempSync(join(tmpdir(), "jarvis-obsidian-")), "TestVault");
  makeVault(vault);
  await api("POST", "/setup/data-folder", { path: stack.dataDir });
  await api("POST", "/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${stack.fixtureUrl}/model`, model: "fixture" } });
  const imp = await api("POST", "/import", { path: vault, label: "TestVault" });
  expect(imp.job).toBeTruthy();
  await api("POST", "/setup/complete");
  // Install the built plugin assets exactly as a user would: copy into .obsidian/plugins.
  const pluginDir = join(vault, ".obsidian/plugins/jarvis-companion");
  mkdirSync(pluginDir, { recursive: true });
  cpSync(join(ROOT, "apps/obsidian/dist/jarvis-companion"), pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, "data.json"), JSON.stringify({ serviceUrl: stack.url, clientName: "Obsidian test" }));
  writeFileSync(join(vault, ".obsidian/community-plugins.json"), JSON.stringify(["jarvis-companion"]));
  // Isolated Obsidian profile with only the test vault registered.
  const home = mkdtempSync(join(tmpdir(), "jarvis-obsidian-home-"));
  mkdirSync(join(home, "Library/Application Support/obsidian"), { recursive: true });
  writeFileSync(join(home, "Library/Application Support/obsidian/obsidian.json"), JSON.stringify({ vaults: { jarvistestvault01: { path: vault, ts: Date.now(), open: true } }, updateDisabled: true }));
  obsidian = spawn(OBSIDIAN, ["--remote-debugging-port=9334"], { env: { ...process.env, CFFIXED_USER_HOME: home, HOME: home }, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch("http://127.0.0.1:9334/json/list")).json();
      if (list.some((t: { url: string; type: string }) => t.type === "page" && t.url.startsWith("app://obsidian.md"))) break;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  browser = await chromium.connectOverCDP("http://127.0.0.1:9334");
  page = browser.contexts()[0]!.pages().find((p) => p.url().startsWith("app://obsidian.md"))!;
  await page.waitForFunction(() => !!(window as any).app?.workspace?.layoutReady, null, { timeout: 30_000 });
});

test.afterAll(async () => {
  await browser?.close().catch(() => {});
  obsidian?.kill("SIGTERM");
  await stack?.stop();
});

test("installs from the built assets and loads after trusting the vault", async () => {
  const trust = page.getByRole("button", { name: /Trust author and enable plugins/ });
  if (await trust.isVisible({ timeout: 5000 }).catch(() => false)) await trust.click();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !!(window as any).app.plugins.plugins["jarvis-companion"], null, { timeout: 20_000 });
  const manifest = await page.evaluate(() => (window as any).app.plugins.manifests["jarvis-companion"]);
  expect(manifest).toMatchObject({ id: "jarvis-companion", isDesktopOnly: true });
});

test("pairs through its settings tab; the token goes to SecretStorage, not the vault", async () => {
  const { code } = await api("POST", "/clients/pairing-code");
  await page.evaluate(() => {
    const a = (window as any).app;
    a.setting.open();
    a.setting.openTabById("jarvis-companion");
  });
  // Obsidian 1.13 shows Settings in its own window; it may also render in-app on other versions.
  let settings: Page = page;
  for (let i = 0; i < 40; i++) {
    const w = browser.contexts()[0]!.pages().find((p) => /Not paired yet/.test(p.url()) || p !== page);
    const candidates = browser.contexts().flatMap((c) => c.pages());
    const found = await Promise.all(candidates.map(async (p) => ((await p.getByText(/Not paired yet/).count().catch(() => 0)) > 0 ? p : null)));
    const hit = found.find(Boolean);
    if (hit) {
      settings = hit;
      break;
    }
    void w;
    await new Promise((r) => setTimeout(r, 250));
  }
  await expect(settings.getByText(/Jarvis .* is running\. Not paired yet\./)).toBeVisible();
  await settings.getByPlaceholder("ABCD2345").fill(code);
  await settings.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(settings.getByText(/Connected to Jarvis .* as “Obsidian test \(TestVault\)”/)).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => (window as any).app.setting.close());
  const stored = await page.evaluate(() => (window as any).app.secretStorage.getSecret("jarvis-client-token"));
  expect(stored).toBeTruthy();
  const data = readFileSync(join(vault, ".obsidian/plugins/jarvis-companion/data.json"), "utf8");
  expect(data).not.toContain(stored);
  const clients = await api("GET", "/clients");
  expect(clients.some((c: { kind: string; name: string }) => c.kind === "obsidian" && c.name.includes("TestVault"))).toBe(true);
});

test("asks about the current note and opens the cited note at its line", async () => {
  await page.evaluate(async () => {
    const a = (window as any).app;
    await a.workspace.openLinkText("Projects/Orion.md", "", false);
    a.commands.executeCommandById("jarvis-companion:ask-about-note");
  });
  const view = page.locator(".jarvis-view");
  await expect(view.locator(".jarvis-context")).toContainText("About: Orion");
  await view.locator("textarea.jarvis-input").fill("When is the cutover plan due?");
  await view.locator("form.jarvis-form button[type=submit]").click();
  const answer = view.locator(".jarvis-a").last();
  await expect(answer).toHaveAttribute("data-status", "complete", { timeout: 30_000 });
  await expect(answer).toContainText("Send the cutover plan to finance");
  // Same conversation store as the browser.
  const convs = await api("GET", "/conversations");
  expect(convs.some((c: { title: string }) => c.title.includes("cutover plan"))).toBe(true);
  await page.evaluate(async () => (window as any).app.workspace.openLinkText("People/Priya Shah.md", "", false));
  await view.locator(".jarvis-source").first().click();
  await page.waitForFunction(() => (window as any).app.workspace.getActiveFile()?.path === "Projects/Orion.md", null, { timeout: 10_000 });
});

test("captures the selected text with provenance into the same memory", async () => {
  await page.evaluate(async () => {
    const a = (window as any).app;
    await a.workspace.openLinkText("Projects/Orion.md", "", false);
    const ed = a.workspace.activeEditor.editor;
    ed.setSelection({ line: 5, ch: 0 }, { line: 5, ch: ed.getLine(5).length });
    a.commands.executeCommandById("jarvis-companion:capture-selection");
  });
  await expect(page.getByText(/Captured to Jarvis: evidence\/captures\//)).toBeVisible({ timeout: 10_000 });
  const docs = await api("GET", "/memory/documents?area=evidence");
  const cap = docs.find((d: { relPath: string }) => d.relPath.startsWith("evidence/captures/") && d.relPath.includes("orion"));
  expect(cap).toBeTruthy();
  const doc = await api("GET", `/memory/document?root=data&path=${encodeURIComponent(cap.relPath)}`);
  expect(doc.raw).toContain("Owner: Priya Shah");
  expect(doc.frontmatter.source).toMatchObject({ kind: "note", ref: "Projects/Orion.md", lines: [6, 6] });
  expect(doc.frontmatter.source.label).toContain("TestVault");
  // The plugin wrote nothing into the vault itself.
  expect(existsSync(join(vault, "evidence"))).toBe(false);
});

test("opens attention items and starts a background job in the same queue", async () => {
  await page.evaluate(() => (window as any).app.commands.executeCommandById("jarvis-companion:open-attention"));
  const view = page.locator(".jarvis-view");
  await expect(view.locator(".jarvis-item", { hasText: "Review rollback runbook" })).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => (window as any).app.commands.executeCommandById("jarvis-companion:research-note"));
  await expect(page.getByText(/researching “Orion” in the background/)).toBeVisible();
  const jobs = await api("GET", "/jobs");
  expect(jobs.some((j: { kind: string; title: string }) => j.kind === "research" && j.title.includes("Orion"))).toBe(true);
});

test("unloads cleanly and closing Obsidian leaves the service running", async () => {
  const result = await page.evaluate(async () => {
    const a = (window as any).app;
    await a.plugins.disablePlugin("jarvis-companion");
    return {
      loaded: !!a.plugins.plugins["jarvis-companion"],
      views: document.querySelectorAll(".jarvis-view").length,
      commands: Object.keys(a.commands.commands).filter((k) => k.startsWith("jarvis-companion:")).length,
    };
  });
  expect(result).toEqual({ loaded: false, views: 0, commands: 0 });
  await browser.close();
  obsidian?.kill("SIGTERM");
  await new Promise((r) => obsidian!.once("exit", r));
  obsidian = null;
  const health = await (await fetch(`${stack.url}/api/v1/health`)).json();
  expect(health.ok).toBe(true);
  expect(hash(USER_OBSIDIAN_JSON)).toBe(userHashBefore);
});
