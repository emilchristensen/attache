import { test, expect, type Page, type BrowserContextOptions, type BrowserType, type Locator } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { JourneyBrowser } from "./browser.ts";
import { buildAll, endApproval, harnessSave, startStack, type Stack } from "./stack.ts";
import { findParenthesisedPlurals } from "../../scripts/check-docs/plurals.mjs";

const VENDOR = "memory/decisions/email-vendor.md";

let stack: Stack;
let journeys: JourneyBrowser;

/** The service runs on this computer with this environment, so its Documents folder is this one. */
const DOCUMENTS = join(process.platform === "win32" ? process.env.USERPROFILE || homedir() : process.env.HOME || homedir(), "Documents");

/**
 * Fails when a view names macOS or the Mac on Linux or Windows. On macOS the
 * Dashboard may name its own platform, such as the Keychain in Settings.
 */
async function expectNoMacWording(page: Page, where: string) {
  if (process.platform === "darwin") return;
  await page.waitForLoadState("networkidle");
  const text = await page.locator("body").innerText();
  const placeholders = await page.locator("input[placeholder]").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).placeholder));
  expect([text, ...placeholders].join("\n"), `macOS wording on ${where}`).not.toMatch(/macOS|\bMac\b|\/Users\//);
}

test.describe.configure({ mode: "serial" });

/** An empty bare repository standing in for the owner's private GitHub repository. */
function createBareRemote(): string {
  const url = join(mkdtempSync(join(tmpdir(), "attache-e2e-remote-")), "brain.git");
  execFileSync("git", ["init", "--bare", "--quiet", "-b", "main", url]);
  return url;
}

test.beforeAll(async ({ browser }) => {
  buildAll();
  stack = await startStack();
  journeys = await JourneyBrowser.start(browser, stack.url);
});
test.afterAll(async () => {
  await journeys?.close();
  await stack?.stop();
});

/**
 * A page in headless Chrome that always draws classic scrollbars, which take room beside the content as on Linux and Windows.
 * Headless Chrome hides scrollbars unless told otherwise. macOS draws zero-width overlay scrollbars when no mouse is attached,
 * and only an `-AppleShowScrollBars Always` pair on Chrome's command line overrides that; Playwright refuses the bare `Always`,
 * so a script in `dir` appends it. Elsewhere Chrome launches as is.
 */
async function pageWithClassicScrollbars(playwright: { chromium: BrowserType }, dir: string, options: BrowserContextOptions): Promise<{ page: Page; close: () => Promise<void> }> {
  const chrome = await playwright.chromium.launch({ ...classicScrollbarChrome(dir), headless: true, ignoreDefaultArgs: ["--hide-scrollbars"] });
  return { page: await (await chrome.newContext(options)).newPage(), close: () => chrome.close() };
}

function classicScrollbarChrome(dir: string): { channel: "chrome" } | { executablePath: string } {
  if (process.platform !== "darwin") return { channel: "chrome" };
  mkdirSync(dir, { recursive: true });
  const launcher = join(dir, "chrome-classic-scrollbars.sh");
  writeFileSync(launcher, `#!/bin/sh\nexec "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "$@" -AppleShowScrollBars Always\n`, { mode: 0o755 });
  return { executablePath: launcher };
}

/** Pairing and service recovery share one compact form, centred in the window at every width without scrolling sideways. */
async function expectCompactCentred(page: Page, where: string) {
  const { left, right, width, overflow } = await page.getByRole("main").evaluate((el) => {
    const box = el.getBoundingClientRect();
    return { left: box.left, right: document.documentElement.clientWidth - box.right, width: box.width, overflow: document.documentElement.scrollWidth - innerWidth };
  });
  expect(Math.abs(left - right), `${where}: centred`).toBeLessThanOrEqual(1);
  expect(width, `${where}: compact`).toBeLessThanOrEqual(480);
  expect(overflow, `${where}: no sideways scrolling`).toBeLessThanOrEqual(0);
}

test("pairing: a compact centred form names a missing or wrong code beside the field and puts focus back in it", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  try {
    const page = await ctx.newPage();
    journeys.watch(page);
    await page.goto(stack.url);
    await expect(page.getByRole("heading", { name: "Pair this browser" })).toBeVisible();
    await expectCompactCentred(page, "pair at 1360px");
    const code = page.getByRole("textbox", { name: "Pairing code" });
    const pair = page.getByRole("button", { name: "Pair", exact: true });
    // Pair is never greyed out: pressing it says what is missing.
    await code.blur();
    await pair.click();
    await expect(code).toBeFocused();
    await expect(code).toHaveAttribute("aria-invalid", "true");
    await expect(code).toHaveAccessibleDescription(/Enter the pairing code\./);
    await code.fill("WRONG234");
    await expect(code).not.toHaveAttribute("aria-invalid", "true");
    await pair.click();
    await expect(code).toHaveAccessibleDescription(/wrong, expired or already used/);
    await expect(code).toBeFocused();
    await expect(page.getByText("attache pair --open")).toBeVisible();
    await page.setViewportSize({ width: 375, height: 812 });
    await expectCompactCentred(page, "pair at 375px");
  } finally {
    await ctx.close();
  }
});

test("setup keeps its place when a step grows taller than the window", async ({ playwright }, testInfo) => {
  const { page, close } = await pageWithClassicScrollbars(playwright, testInfo.outputPath(), { viewport: { width: 1360, height: 900 } });
  try {
    await page.goto(stack.pairUrl());
    await expect(page.getByRole("heading", { name: "Where should Attache keep your knowledge?" })).toBeVisible();
    const column = async () => (await page.locator("main.setup").boundingBox())!.x;
    expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(false);
    const short = await column();
    // Previews only read: the folders are left as they are for the onboarding journey.
    await page.getByRole("textbox", { name: /Data folder/ }).fill(stack.dataDir);
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await page.getByText("Import an existing Markdown folder or Obsidian vault").click();
    await page.getByRole("textbox", { name: "Folder to import" }).fill(stack.vaultDir);
    await page.getByRole("button", { name: "Preview import" }).click();
    await expect(page.getByText(/^Will read 2 Markdown files from /)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true);
    expect(await column()).toBe(short);
  } finally {
    await close();
  }
});

test("onboarding: pair, choose folder, preview import, features, connections, model, finish", async () => {
  const page = await journeys.newPage();
  // The suggested folder arrives only once the owner has started typing their own, and must not mix into it.
  let suggest = () => {};
  const suggested = new Promise<void>((r) => (suggest = r));
  await page.route("**/api/v1/setup/defaults", async (route) => {
    await suggested;
    await route.continue();
  });
  await page.goto(stack.pairUrl());
  const heading = page.getByRole("heading", { name: "Where should Attache keep your knowledge?" });
  await expect(heading).toBeVisible();
  // Two panes: the steps on the left, the form on the right.
  const progress = page.getByRole("navigation", { name: "Setup progress" });
  const pane = await page.getByRole("complementary").filter({ has: progress }).boundingBox();
  const form = await heading.boundingBox();
  expect(pane!.x + pane!.width, "the steps sit left of the form").toBeLessThan(form!.x);
  expect(Math.abs(pane!.y - form!.y), "the two panes start level").toBeLessThanOrEqual(8);
  await expect(progress.getByRole("button", { name: /Data folder/ })).toHaveAttribute("aria-current", "step");
  // The optional parts are closed disclosures below Continue.
  const useFolder = page.getByRole("button", { name: "Use this folder" });
  const importSummary = page.getByText("Import an existing Markdown folder or Obsidian vault");
  expect((await importSummary.boundingBox())!.y, "Continue comes before the optional parts").toBeGreaterThan((await useFolder.boundingBox())!.y);
  await expect(page.getByRole("textbox", { name: "Folder to import" })).toBeHidden();
  const folder = page.getByRole("textbox", { name: /Data folder/ });
  await folder.click();
  const answered = page.waitForResponse("**/api/v1/setup/defaults");
  suggest();
  await answered;
  await folder.pressSequentially(stack.dataDir);
  await expect(folder).toHaveValue(stack.dataDir);
  await page.unroute("**/api/v1/setup/defaults");
  // Continue is never greyed out: pressing it names the first problem beside its field and puts focus there.
  await folder.blur();
  await useFolder.click();
  await expect(folder).toBeFocused();
  await expect(folder).toHaveAttribute("aria-invalid", "true");
  await expect(folder).toHaveAccessibleDescription(/Preview this folder to see what Attache will create in it\./);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByText(`New folder: ${stack.dataDir}`)).toBeVisible();
  await expect(page.getByText("Will modify: nothing")).toBeVisible();
  await expect(folder).not.toHaveAttribute("aria-invalid", "true");
  await importSummary.click();
  const importFolder = page.getByRole("textbox", { name: "Folder to import" });
  // Example folders are shaped for the computer Attache runs on.
  await expect(importFolder).toHaveAttribute("placeholder", join(DOCUMENTS, "Notes"));
  await expectNoMacWording(page, "setup: data folder");
  await importFolder.fill(stack.vaultDir);
  // A folder to import that was not previewed is named too, and its closed disclosure opens to show it.
  await importSummary.click();
  await expect(importFolder).toBeHidden();
  await useFolder.click();
  await expect(importFolder).toBeFocused();
  await expect(importFolder).toHaveAccessibleDescription(/Preview the import, or clear this field\./);
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(page.getByText(/^Will read 2 Markdown files from /)).toBeVisible();
  await expect(page.getByText("Files changed in that folder: 0")).toBeVisible();
  await page.getByText("Who is this for?").click();
  await page.getByRole("textbox", { name: "Name" }).fill("Test User");
  await page.getByRole("textbox", { name: "Email" }).fill("alex@example.com");
  await useFolder.click();

  await expect(page.getByRole("heading", { name: "Choose what Attache does" })).toBeVisible();
  await expect(progress.getByRole("button", { name: /Features/ })).toHaveAttribute("aria-current", "step");
  await expect(progress.getByRole("button", { name: /Data folder/ })).toHaveAccessibleName(/done/);
  // Voice is not a feature any more.
  await expect(page.getByRole("checkbox", { name: /^Voice/ })).toHaveCount(0);
  // Keyboard: toggle drafts off and on with Space, then check the dependency explanation for Background work.
  const drafts = page.getByRole("checkbox", { name: /^Drafts and approvals/ });
  await drafts.focus();
  await page.keyboard.press("Space");
  await expect(drafts).not.toBeChecked();
  await page.keyboard.press("Space");
  await expect(drafts).toBeChecked();
  await page.getByRole("checkbox", { name: /^Background work/ }).click();
  await expect(page.getByRole("alert")).toContainText("Attention and briefings needs Background work");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("checkbox", { name: /^Background work/ })).toBeChecked();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Connect sources (optional)" })).toBeVisible();
  const gh = page.locator('[data-connection="github"]');
  await gh.getByRole("button", { name: "Set up" }).click();
  await expect(gh.getByText("Before you connect")).toBeVisible();
  await gh.getByRole("textbox", { name: "Token" }).fill("ghp_fixturetokenfixturetoken12345678");
  await gh.getByRole("button", { name: "Connect" }).click();
  await expect(gh.getByText("connected", { exact: true })).toBeVisible();
  await expect(gh.getByText("Signed in as alex")).toBeVisible();
  // Harnesses: connecting Claude Code adds Attache's MCP server and hooks, and keeps the user's own entries.
  await expect(page.locator('[data-connection="claude-desktop"]')).toBeVisible();
  const claude = page.locator('[data-connection="claude-code"]');
  await claude.getByRole("button", { name: "Set up" }).click();
  await expect(claude.getByText(/Adds Attache's MCP server to ~\/.claude.json and three hooks to ~\/.claude\/settings.json/)).toBeVisible();
  await claude.getByRole("button", { name: "Connect" }).click();
  await expect(claude.getByText("connected", { exact: true })).toBeVisible();
  const claudeSettings = JSON.parse(readFileSync(join(stack.agentHome, ".claude/settings.json"), "utf8"));
  expect(claudeSettings.hooks.PreToolUse[0].hooks[0].command).toBe("rtk hook claude");
  for (const e of ["SessionStart", "PreCompact", "SessionEnd"]) expect(JSON.stringify(claudeSettings.hooks[e])).toContain("attache-agent-hook");
  const claudeMcp = JSON.parse(readFileSync(join(stack.agentHome, ".claude.json"), "utf8")).mcpServers;
  expect(Object.values(claudeMcp)).toEqual([expect.objectContaining({ args: expect.arrayContaining(["mcp", "--state-dir", stack.stateDir]) })]);
  // A Harness that is not installed says so instead of writing anything.
  const codex = page.locator('[data-connection="codex"]');
  await codex.getByRole("button", { name: "Set up" }).click();
  await codex.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText(/Codex was not found on this Machine/)).toBeVisible();
  await expect(codex.getByText("not connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Model and schedules" })).toBeVisible();
  const model = page.locator('[data-connection="model"]');
  await model.getByRole("button", { name: "Set up" }).click();
  await model.getByRole("combobox", { name: "How to connect" }).selectOption("openai-compatible");
  await model.getByRole("textbox", { name: "Base URL" }).fill(`${stack.fixtureUrl}/model`);
  await model.getByRole("textbox", { name: "Model" }).fill("fixture-model");
  await model.getByRole("button", { name: "Connect" }).click();
  await expect(model.getByText("connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Show a desktop notification for new urgent items" })).toBeVisible();
  await expect(page.getByText("If this Machine sleeps, missed runs are caught up once when it wakes.")).toBeVisible();
  await expectNoMacWording(page, "setup: model and schedules");
  await page.getByRole("spinbutton", { name: /Refresh sources every/ }).fill("20");
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Check and finish" })).toBeVisible();
  await expect(page.locator('[data-feature-status="drafts"]')).toContainText("ready");
  await expect(page.locator('[data-feature-status="attention"]')).toContainText("ready");
  await page.getByRole("button", { name: "Finish setup" }).click();
  await expect(page.getByRole("navigation", { name: "Main" }).first()).toBeVisible();
  await expect(page.getByText("Needs your attention")).toBeVisible();
  await expect(page.getByText(/Overdue: Review rollback runbook/)).toBeVisible();
  await expect(page.getByText(/Review acme\/web#42/)).toBeVisible({ timeout: 20_000 });
  // No microphone control or speech hint anywhere on the Dashboard.
  await expect(page.getByRole("button", { name: /talk|microphone|speaking/i })).toHaveCount(0);
  await expect(page.getByText(/stops speech/)).toHaveCount(0);
});

test("service not reachable: the pairing screen's centred layout, the commands to check the service, and Retry", async () => {
  const page = await journeys.newPage();
  await page.route("**/api/v1/session", (route) => route.abort());
  await page.goto(stack.url);
  await expect(page.getByRole("heading", { name: "Attache service is not reachable" })).toBeVisible();
  await expect(page.getByText("attache status")).toBeVisible();
  await expectCompactCentred(page, "service not reachable at 1360px");
  await page.setViewportSize({ width: 375, height: 812 });
  await expectCompactCentred(page, "service not reachable at 375px");
  await page.unroute("**/api/v1/session");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("navigation", { name: "Main" }).first()).toBeVisible();
  await page.close();
});

test("home: the inbox only, with no chat box or chat shortcut", async () => {
  const page = await journeys.open("/");
  await expect(page.getByText("Needs your attention")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Attache" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Conversation" })).toHaveCount(0);
  await expect(page.getByRole("separator")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main" }).first()).not.toContainText("ask");
  // `/` used to jump to the chat box; now it does nothing, wherever you are.
  await page.goto(`${stack.url}/jobs`);
  await page.keyboard.press("/");
  await expect(page).toHaveURL(`${stack.url}/jobs`);
});

test("look: the Dashboard sets its text in Inter, served by Attache itself, and loads nothing from the internet", async () => {
  const page = await journeys.newPage();
  const requests: string[] = [];
  const fonts: Array<{ url: string; type: string | undefined }> = [];
  page.on("request", (r) => requests.push(r.url()));
  page.on("response", (r) => {
    if (r.request().resourceType() === "font") fonts.push({ url: r.url(), type: r.headers()["content-type"] });
  });
  await page.goto(`${stack.url}/`);
  await expect(page.getByText("Needs your attention")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toMatch(/^"?Inter"?,/);
  expect(await page.evaluate(() => [...document.fonts].some((f) => f.family.replace(/"/g, "") === "Inter" && f.status === "loaded"))).toBe(true);
  expect(fonts).toEqual([{ url: expect.stringMatching(new RegExp(`^${stack.url}/assets/inter-latin-wght-normal-[\\w-]+\\.woff2$`)), type: "font/woff2" }]);
  expect(requests.filter((u) => !u.startsWith(`${stack.url}/`) && !u.startsWith("data:"))).toEqual([]);
  await page.close();
});

/** WCAG contrast of an element's outline or border colour against the opaque surface behind it, as rendered. */
const measure = (target: Locator, what: "outline" | "border") =>
  target.evaluate((el, what) => {
    const parse = (c: string) => {
      const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/.exec(c);
      if (!m) throw new Error(`Unreadable colour ${c}`);
      return { r: +m[1]!, g: +m[2]!, b: +m[3]!, a: m[4] === undefined ? 1 : +m[4] };
    };
    // The surface behind the element: its parents' backgrounds painted from the page down.
    const layers: string[] = [];
    for (let n = el.parentElement; n; n = n.parentElement) layers.push(getComputedStyle(n).backgroundColor);
    type Rgb = { r: number; g: number; b: number };
    const over = (t: Rgb & { a: number }, below: Rgb): Rgb => ({ r: t.r * t.a + below.r * (1 - t.a), g: t.g * t.a + below.g * (1 - t.a), b: t.b * t.a + below.b * (1 - t.a) });
    let bg: Rgb = { r: 255, g: 255, b: 255 };
    for (const c of layers.reverse()) bg = over(parse(c), bg);
    const style = getComputedStyle(el);
    // Measured as painted: an outline sits outside, over the surface; a border sits over the control's own fill
    // (background-clip: border-box), which sits over the surface.
    const fg = what === "outline" ? over(parse(style.outlineColor), bg) : over(parse(style.borderTopColor), over(parse(style.backgroundColor), bg));
    const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const lin = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    };
    const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x) as [number, number];
    return { ratio: (hi + 0.05) / (lo + 0.05), width: what === "outline" ? parseFloat(style.outlineWidth) : parseFloat(style.borderTopWidth), style: what === "outline" ? style.outlineStyle : style.borderTopStyle };
  }, what);

test("look: focus rings, control edges and healthy states, measured on the surfaces they render on, in light and dark", async () => {
  const page = await journeys.newPage();
  await page.goto(`${stack.url}/`);
  await expect(page.getByText("Needs your attention")).toBeVisible();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const onFeature = page.locator(".briefing").getByRole("button", { name: "Away summary" });
    const onCard = page.locator(".item").first().getByRole("button", { name: "Evidence" });
    const onCanvas = page.getByRole("button", { name: "Show dismissed" });
    // Control edges: a secondary button on the amber briefing and on a card.
    for (const control of [onFeature, onCard]) {
      const edge = await measure(control, "border");
      expect(edge, `${scheme} control edge`).toMatchObject({ width: 1, style: "solid" });
      expect(edge.ratio, `${scheme} control edge`).toBeGreaterThanOrEqual(3);
    }
    // The focus ring: a 3 px outline (never a fill like a selection), at 3:1 or better on every surface it lands on.
    for (const control of [onFeature, onCard, onCanvas]) {
      await control.focus();
      const ring = await measure(control, "outline");
      expect(ring, `${scheme} focus ring`).toMatchObject({ width: 3, style: "solid" });
      expect(ring.ratio, `${scheme} focus ring`).toBeGreaterThanOrEqual(3);
    }
    // A healthy state is plain words, never a coloured pill.
    const healthy = page.locator(".coverage").getByText("complete", { exact: true }).first();
    await expect(healthy).toBeVisible();
    expect(await healthy.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  }
  await page.close();
});

test("search: a hit opens the exact evidence lines, keyboard", async () => {
  const page = await journeys.open("/brain");
  const search = page.getByRole("searchbox", { name: "Search the Brain" });
  await search.fill("When is the cutover plan due for the Orion migration?");
  const hit = page.locator(".list-item", { hasText: "Orion" }).first();
  await expect(hit).toBeVisible();
  await hit.focus();
  await page.keyboard.press("Enter");
  const drawer = page.getByRole("dialog", { name: /Evidence/ });
  await expect(drawer).toBeVisible();
  const hl = drawer.locator(".line.hl");
  await expect(hl.first()).toBeVisible();
  expect(await hl.allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining("Send the cutover plan to finance")]));
  await expect(drawer.getByText(join(stack.vaultDir, "Projects", "Orion.md"))).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});

test("attention: dismiss persists across reload and briefings; briefing reports coverage", async () => {
  const page = await journeys.open("/");
  const item = page.locator("article.item", { hasText: "Review rollback runbook" });
  await item.getByRole("button", { name: "Dismiss" }).click();
  await expect(item).toBeHidden();
  const cutover = page.locator("article.item", { hasText: "Send the cutover plan to finance" });
  await cutover.getByRole("button", { name: "Snooze" }).click();
  await cutover.getByRole("group", { name: "Snooze until" }).getByRole("button", { name: "1 hour" }).click();
  await expect(cutover).toBeHidden();
  await page.getByRole("button", { name: "Prepare briefing" }).click();
  await expect(page.locator(".briefing-lines li").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("group", { name: "Briefing at a glance" }).getByRole("button", { name: /Review queue/ }).click();
  await expect(page.getByRole("region", { name: "Review queue" })).toBeInViewport();
  await page.reload();
  await expect(page.getByText(/Review acme\/web#42/)).toBeVisible();
  // The logo's dot says something needs attention.
  await expect(page.locator(".masthead .brand .logo-dot")).toHaveCount(1);
  await expect(page.locator("article.item", { hasText: "Review rollback runbook" })).toHaveCount(0);
  await expect(page.locator("article.item", { hasText: "Send the cutover plan to finance" })).toHaveCount(0);
  await page.getByRole("button", { name: "Show dismissed" }).click();
  await expect(page.locator("article.item", { hasText: "Review rollback runbook" })).toBeVisible();
  await expect(page.locator("article.item", { hasText: "Send the cutover plan to finance" })).toContainText("snoozed until");
  await page.getByRole("button", { name: "Show open" }).click();
  await expect(page.locator(".coverage")).toContainText("GitHub");
});

test("drafts: a rejected draft frees its item to be drafted again and stays listed as finished", async () => {
  const page = await journeys.open("/");
  const pr = page.locator("article.item", { hasText: "Review acme/web#42" });
  await pr.getByRole("button", { name: "Prepare draft" }).click();
  await expect(pr.getByRole("button", { name: "View draft" })).toBeVisible({ timeout: 30_000 });
  await pr.getByRole("button", { name: "View draft" }).click();
  const draft = page.locator("[data-action-id]");
  await expect(draft).toHaveAttribute("data-status", "draft");
  const rejectedId = await draft.getAttribute("data-action-id");
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(draft).toHaveAttribute("data-status", "rejected");
  await page.getByRole("link", { name: "Home" }).click();
  await expect(pr.getByRole("button", { name: "Prepare draft" })).toBeVisible();
  await expect(pr.getByRole("button", { name: "View draft" })).toHaveCount(0);
  await page.goto(`${stack.url}/approvals?id=${rejectedId}`);
  await page.getByRole("tab", { name: "Finished" }).click();
  await expect(page.getByRole("button", { name: /Review acme\/web#42/ }).first()).toBeVisible();
  await expect(page.locator("[data-action-id]")).toHaveAttribute("data-status", "rejected");
});

test("drafts: prepare, edit, approve, blocked until write is authorised, then verified receipt", async () => {
  const page = await journeys.open("/");
  const pr = page.locator("article.item", { hasText: "Review acme/web#42" });
  await pr.getByRole("button", { name: "Prepare draft" }).click();
  await expect(pr.getByRole("button", { name: "View draft" })).toBeVisible({ timeout: 30_000 });
  await pr.getByRole("button", { name: "View draft" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Approvals" })).toBeVisible();
  const box = page.getByRole("textbox", { name: "Text" });
  await expect(box).toHaveValue(/reviewed the changes/);
  // The citation under the Draft's context is a button: its edge reaches 3:1 on the card it sits on, in both themes.
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const edge = await measure(page.locator(".source-chip").first(), "border");
    expect(edge, `${scheme} citation edge`).toMatchObject({ width: 1, style: "solid" });
    expect(edge.ratio, `${scheme} citation edge`).toBeGreaterThanOrEqual(3);
  }
  await page.emulateMedia({ colorScheme: null });
  await box.fill("Looks good. One question: does the retry respect idempotency keys?");
  await page.getByRole("button", { name: "Save new version" }).click();
  await expect(page.getByText("v2 ·")).toBeVisible();
  await page.getByRole("button", { name: "Approve v2" }).click();
  await expect(page.getByText("Cannot send yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
  // Grant the separate write permission.
  await page.goto(`${stack.url}/connections`);
  const gh = page.locator('[data-connection="github"]');
  await gh.getByText(/Write permissions/).click();
  await gh.getByRole("checkbox", { name: /Post a comment/ }).check();
  await gh.getByRole("checkbox", { name: /I understand/ }).check();
  await gh.getByRole("button", { name: "Save write permissions" }).click();
  await expect(gh.getByText("Post a comment on a pull request or issue", { exact: false }).first()).toBeVisible();
  await page.goto(`${stack.url}/approvals`);
  // The owner steps away and the 15-minute approval ends: the draft goes back to needing approval, and approving again is one click.
  const detail = page.locator("[data-action-id]");
  await expect(detail).toHaveAttribute("data-status", "approved");
  endApproval(stack, (await detail.getAttribute("data-action-id"))!);
  await page.reload();
  await expect(detail).toHaveAttribute("data-status", "draft");
  await expect(page.getByRole("status").filter({ hasText: /^The approval of v2 ended at .+\. Nothing was sent\.$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send" })).toHaveCount(0);
  await page.getByRole("button", { name: "Approve v2 again" }).click();
  await expect(detail).toHaveAttribute("data-status", "approved");
  await page.getByRole("button", { name: "Send" }).click();
  const receipt = page.locator("[data-receipt]");
  await expect(receipt).toContainText("Verified", { timeout: 20_000 });
  await expect(page.locator("[data-action-id]")).toHaveAttribute("data-status", "succeeded");
  // A sent draft is finished too: the item no longer points at it.
  await page.getByRole("link", { name: "Home" }).click();
  await expect(pr.getByRole("button", { name: "Prepare draft" })).toBeVisible();
});

test("jobs: work continues after the tab closes; cancellation reports what happened", async () => {
  const page = await journeys.open("/jobs");
  await page.getByRole("textbox", { name: "Research question" }).fill("What is the state of the Orion migration?");
  await page.getByRole("button", { name: "Research" }).click();
  await expect(page.locator("[data-job-id]")).toBeVisible();
  const jobUrl = page.url();
  await page.close();
  const page2 = await journeys.newPage();
  await page2.goto(jobUrl);
  await expect(page2.locator("[data-job-id]")).toHaveAttribute("data-status", "succeeded", { timeout: 30_000 });
  await expect(page2.getByRole("button", { name: /Open deliverables\/research/ })).toBeVisible();
  await page2.getByRole("button", { name: "Diagnostics" }).click();
  await expect(page2.locator("[data-job-id]")).toHaveAttribute("data-status", "running");
  await page2.getByRole("button", { name: "Cancel" }).click();
  await expect(page2.locator("[data-job-id]")).toHaveAttribute("data-status", "cancelled");
  await expect(page2.getByText("Cancelled: the work stopped before finishing.").first()).toBeVisible();
});

test("wording: counts read as words in the right number, never with (s)", async () => {
  const page = await journeys.open("/connections");
  await page.getByRole("textbox", { name: "Folder path" }).fill(stack.vaultDir);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByText("Reads 2 Markdown files · changes 0 files")).toBeVisible();

  await page.locator('[data-connection="github"]').getByRole("button", { name: "Disconnect…" }).click();
  const disconnect = page.getByRole("alertdialog", { name: "Disconnect" });
  await expect(disconnect).toContainText("Attache deletes the stored credentials and stops all requests.");
  await expect(disconnect).toContainText(/\d+ queued jobs? will be cancelled and approvals for \d+ drafts? revoked\./);
  await expect(disconnect).toContainText(/Retained data: \d+ observations?, \d+ open Inbox items?\./);
  await disconnect.getByRole("button", { name: "Cancel" }).click();
  // A notes folder has no credentials to delete, and its indexed files are counted too.
  const notes = page.locator(".card", { has: page.getByRole("heading", { name: basename(stack.vaultDir), exact: true }) });
  await notes.getByRole("button", { name: "Disconnect…" }).click();
  await expect(disconnect).toContainText("Attache stops reading from it.");
  await expect(disconnect).not.toContainText("credentials");
  await expect(disconnect).toContainText(/Retained data: \d+ observations?, \d+ open Inbox items?, 2 indexed files\./);
  await disconnect.getByRole("button", { name: "Cancel" }).click();

  await page.goto(`${stack.url}/approvals`);
  await page.getByRole("tab", { name: "Finished" }).click();
  await page.locator(".list-item", { hasText: "acme/web#42" }).first().click();
  await expect(page.getByText("1 changed file", { exact: true })).toBeVisible();

  await page.goto(`${stack.url}/jobs`);
  await page.locator(".list-item", { hasText: "Orion migration" }).first().click();
  await expect(page.locator('[data-event="searched"]').first()).toHaveText(/Searched “.+” — \d+ hits?$/);

  for (const path of ["/", "/brain", "/approvals", "/jobs", "/connections", "/settings"]) {
    await page.goto(`${stack.url}${path}`);
    await expect(page.getByRole("navigation", { name: "Main" }).first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    const text = await page.locator("body").innerText();
    expect(findParenthesisedPlurals(text), `counts with (s) on ${path}`).toEqual([]);
  }
});

test("feature switches: turning attention off changes the product and the backend", async () => {
  const page = await journeys.open("/settings");
  await page.getByRole("checkbox", { name: /^Attention and briefings/ }).click();
  await expect(page.getByRole("alert")).toContainText("Drafts and approvals needs Attention and briefings");
  await page.getByRole("button", { name: "Also turn off what depends on it" }).click();
  await expect(page.getByRole("checkbox", { name: /^Attention and briefings/ })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^Drafts and approvals/ })).not.toBeChecked();
  await expect(page.getByText("Source refresh: off")).toBeVisible();
  await page.goto(stack.url);
  await expect(page.getByText("Attention and briefings is off")).toBeVisible();
  await page.goto(`${stack.url}/settings`);
  await page.getByRole("checkbox", { name: /^Drafts and approvals/ }).click();
  await page.getByRole("button", { name: "Turn on what it needs too" }).click();
  await expect(page.getByRole("checkbox", { name: /^Attention and briefings/ })).toBeChecked();
  await expect(page.getByText(/Source refresh: next/)).toBeVisible();
});

test("this Machine: named after its hostname, renamed in Settings, and the name is kept", async () => {
  const page = await journeys.open("/settings");
  const card = page.locator(".card", { has: page.getByRole("heading", { name: "This Machine" }) });
  const name = card.getByRole("textbox", { name: "Name" });
  await expect(name).not.toHaveValue("");
  const id = await card.locator(".mono").textContent();
  await name.fill("Home PC");
  await card.getByRole("button", { name: "Rename" }).click();
  await expect(page.getByText("Machine renamed")).toBeVisible();
  await page.reload();
  await expect(card.getByRole("textbox", { name: "Name" })).toHaveValue("Home PC");
  await expect(card.locator(".mono")).toHaveText(id!);
});

test("credentials: Settings says which secret store holds them and why", async () => {
  const page = await journeys.open("/settings");
  // The stack forces the private file, as an install without a system secret store would use.
  const store = page.locator("[data-credential-store]");
  await expect(store).toHaveAttribute("data-credential-store", "file");
  await expect(store).toContainText("Private file (only you can read it)");
  await expect(store).toContainText("ATTACHE_CREDENTIAL_STORE=file chose the file.");
});

test("meaning-based search: search says it matches keywords only, and why, until the owner downloads the model in Settings", async () => {
  const page = await journeys.open("/brain");
  await page.getByRole("searchbox", { name: "Search the Brain" }).fill("Orion");
  await expect(page.locator("[data-keywords-only]")).toContainText("the meaning model is not downloaded");
  await expect(page.locator(".list-item").first()).toBeVisible();

  await page.locator("[data-keywords-only]").getByRole("link", { name: "Settings" }).click();
  const card = page.locator("[data-meaning-search]");
  await expect(card.getByText("not downloaded")).toBeVisible();
  await card.getByRole("button", { name: /^Download model/ }).click();
  await expect(card.getByText("ready", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(card.getByText(/Every passage in this Machine's index has a vector/)).toBeVisible();
  await expect(card.getByText(/Search ranks by meaning and keywords/)).toBeVisible();
  await expect(card.getByRole("button", { name: /Download/ })).toHaveCount(0);

  // Once the vectors are built, search ranks by meaning and no longer says it matches keywords only.
  await page.goto(`${stack.url}/brain`);
  await page.getByRole("searchbox", { name: "Search the Brain" }).fill("Orion");
  await expect(page.locator(".list-item").first()).toBeVisible();
  await expect(page.locator("[data-keywords-only]")).toHaveCount(0);
});

test("reconnection: service restart shows on this Machine's button in the masthead, then recovers state", async () => {
  const page = await journeys.open("/");
  await expect(page.getByText("Needs your attention")).toBeVisible();
  const machine = page.getByRole("button", { name: /^This Machine/ });
  await stack.stopService();
  await expect(machine).toContainText(/Reconnecting|Disconnected/, { timeout: 20_000 });
  await stack.startService();
  await expect(machine).not.toContainText(/Reconnecting|Disconnected/, { timeout: 30_000 });
  // The Dashboard reaches the service again without a reload.
  await page.getByRole("navigation", { name: "Main" }).first().getByRole("link", { name: "Brain" }).click();
  await page.getByRole("searchbox", { name: "Search the Brain" }).fill("Priya Shah");
  await expect(page.locator(".list-item", { hasText: "Priya" }).first()).toBeVisible();
});

test("narrow screen: the bottom bar, no horizontal overflow, all views reachable", async () => {
  const page = await journeys.open("/");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/", "/brain", "/approvals", "/jobs", "/connections", "/settings"]) {
    await page.goto(`${stack.url}${path}`);
    await expect(page.locator(".bottom-bar")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
  }
  await page.goto(stack.url);
  await expect(page.getByText("Needs your attention")).toBeVisible();
  // Home is the inbox alone, so there is nothing to switch between.
  await expect(page.getByRole("button", { name: "Conversation", exact: true })).toHaveCount(0);
  const navFits = await page.locator(".bottom-bar").evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(navFits, "the bottom bar fits without scrolling").toBe(true);
  await page.locator(".bottom-bar").getByRole("link", { name: "Brain" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Brain" })).toBeVisible();
});

/** Where a page scrolls: the scrollbar of its largest scrolling element, and the column its content sits in. */
interface PageScroll {
  scroller: string;
  scrollbarLeft: number;
  scrollbarRight: number;
  contentLeft: number;
  contentTop: number;
  contentRight: number;
  contentWidth: number;
  /** The system draws overlay scrollbars (macOS with a trackpad), which take no width. */
  overlayScrollbars: boolean;
}

/** Makes the page taller than any window, so it always scrolls, then measures where it scrolls. */
function measurePageScroll(): PageScroll {
  const root = document.documentElement;
  // The page's content column: its first block, or the Setup steps.
  const column = document.querySelector(".page > :first-child, main.setup")!;
  const spacer = document.createElement("div");
  spacer.style.height = "200vh";
  column.parentElement!.append(spacer);
  const scrolls = (el: Element) => (el === root || /auto|scroll/.test(getComputedStyle(el).overflowY)) && el.scrollHeight > el.clientHeight + 1;
  const candidates = [root, ...document.querySelectorAll("body *")].filter((el) => scrolls(el) && !el.closest("nav"));
  const area = (el: Element) => el.clientWidth * el.clientHeight;
  const el = candidates.reduce((a, b) => (area(b) > area(a) ? b : a));
  const box = el === root ? { left: 0, right: innerWidth } : el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const scrollbarRight = box.right - parseFloat(style.borderRightWidth);
  const scrollbarLeft = el === root ? root.clientWidth : box.left + parseFloat(style.borderLeftWidth) + el.clientWidth;
  const content = column.getBoundingClientRect();
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;width:100px;height:100px;overflow:scroll";
  document.body.append(probe);
  const overlayScrollbars = probe.offsetWidth === probe.clientWidth;
  probe.remove();
  return { overlayScrollbars, scroller: el === root ? "html" : `${el.tagName.toLowerCase()}.${[...el.classList].join(".")}`, scrollbarLeft, scrollbarRight, contentLeft: content.left, contentTop: content.top, contentRight: content.right, contentWidth: content.width };
}

test("scrollbars: every page scrolls at the window's right edge, with its content in its column", async ({ playwright }, testInfo) => {
  const { page, close } = await pageWithClassicScrollbars(playwright, testInfo.outputPath(), { storageState: await journeys.context.storageState() });
  try {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 600, height: 800 }]) {
      await page.setViewportSize(viewport);
      let home: PageScroll | undefined;
      for (const path of ["/", "/brain", "/approvals", "/jobs", "/connections", "/settings", "/setup"]) {
        await page.goto(`${stack.url}${path}`);
        await expect(page.locator(".page > :first-child, main.setup").first()).toBeVisible();
        await page.waitForLoadState("networkidle");
        const at = `${path} at ${viewport.width}px`;
        const s = await page.evaluate(measurePageScroll);
        if (!s.overlayScrollbars) expect(s.scrollbarRight - s.scrollbarLeft, `${at}: ${s.scroller} shows a scrollbar`).toBeGreaterThan(0);
        expect(s.scrollbarRight, `${at}: ${s.scroller}'s scrollbar is at the window's right edge`).toBe(viewport.width);
        expect(s.contentRight, `${at}: content stays left of the scrollbar`).toBeLessThanOrEqual(s.scrollbarLeft);
        // Every Dashboard page starts its content at the same place, so switching pages does not shift it.
        home ??= s;
        if (path !== "/setup") expect([s.contentLeft, s.contentTop], `${at}: content starts where Home's does`).toEqual([home.contentLeft, home.contentTop]);
        if (viewport.width < 1280) continue;
        // Wide windows keep the reading columns: Settings and Connections, Home's column centred beside the scrollbar, and the centred Setup steps.
        if (path === "/connections" || path === "/settings") expect(s.contentWidth, `${at}: content column`).toBe(824);
        if (path === "/") {
          expect(s.contentWidth, `${at}: reading column`).toBeLessThanOrEqual(1072);
          expect(Math.abs(s.contentLeft - (s.scrollbarLeft - s.contentRight)), `${at}: the reading column is centred`).toBeLessThanOrEqual(1);
        }
        if (path === "/setup") expect(Math.abs(s.contentLeft - (s.scrollbarLeft - s.contentRight)), `${at}: Setup is centred`).toBeLessThanOrEqual(1);
      }
    }
  } finally {
    await close();
  }
});

test("brain: notes, evidence and deliverables are read-only, with no capture box or correct and edit controls", async () => {
  // Notes reach the Brain from a Harness, never from the Dashboard.
  await harnessSave(stack, [{ action: "create", type: "decision", title: "Email vendor", facts: [{ subject: "Decision", value: "Keep Nimbus as email vendor for 2027" }] }], { agent: "claude-code", session: "sess-e2e-vendor" });
  await harnessSave(stack, [{ action: "update", path: VENDOR, facts: [{ subject: "Decision", value: "Switch to Postmark for 2027", reason: "Procurement chose Postmark" }] }], { agent: "claude-code", session: "sess-e2e-vendor" });
  const page = await journeys.open("/brain?tab=decision");
  await expect(page.getByRole("heading", { level: 1, name: "Brain" })).toBeVisible();
  await expect(page.getByRole("button", { name: /capture/i })).toHaveCount(0);
  await page.locator(".list-item", { hasText: "Email vendor" }).click();
  const state = page.locator('[data-subject="Decision"]');
  await expect(state).toContainText("Switch to Postmark for 2027");
  await expect(page.getByText(/was "Keep Nimbus as email vendor for 2027"/)).toBeVisible();
  await expect(page.getByRole("button", { name: /correct|edit/i })).toHaveCount(0);
  // The note panel has nothing to type into.
  await expect(page.locator(".split textarea, .split input:not([type=search])")).toHaveCount(0);

  // Evidence and deliverables open read-only in the evidence drawer.
  for (const tab of ["Evidence", "Deliverables"]) {
    await page.getByRole("tab", { name: tab }).click();
    const first = page.locator(".split .list-item").first();
    await expect(first).toBeVisible();
    await first.click();
    const drawer = page.getByRole("dialog", { name: /Evidence/ });
    await expect(drawer.locator(".source-view .line").first()).toBeVisible();
    await expect(drawer.locator("textarea, input")).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: /correct|edit|save/i })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
  }

  // The endpoints behind the old controls are closed to the Dashboard's own session.
  const statuses = await page.evaluate(async (note) => {
    const send = (method: string, path: string, body: unknown) =>
      fetch(`/api/v1${path}`, { method, credentials: "same-origin", headers: { "content-type": "application/json", "x-attache-client": "1" }, body: JSON.stringify(body) }).then((r) => r.status);
    return [
      await send("POST", "/memory/capture", { text: "Typed in the Dashboard", source: { kind: "user", ref: "browser capture" } }),
      await send("POST", "/memory/notes", { type: "note", title: "Typed in the Dashboard", state: [{ subject: "Idea", value: "x" }] }),
      await send("POST", "/memory/correct", { relPath: note, subject: "Decision", value: "Typed in the Dashboard", reason: "x" }),
      await send("PUT", "/memory/notes-body", { relPath: note, notes: "Typed in the Dashboard" }),
    ];
  }, VENDOR);
  expect(statuses).toEqual([404, 404, 404, 404]);
  expect(readFileSync(join(stack.dataDir, VENDOR), "utf8")).not.toContain("Typed in the Dashboard");

  // Search finds the current value, not the superseded one.
  await page.getByRole("searchbox", { name: "Search the Brain" }).fill("Which email vendor did we decide on for 2027?");
  const hit = page.locator(".list-item", { hasText: "Email vendor" }).first();
  await expect(hit).toContainText("Postmark");
  await expect(hit).not.toContainText("superseded");
});

test("approvals: a Proposal shows every part of the change and is applied or rejected in one click", async () => {
  const page = await journeys.open("/approvals");
  // Proposals arrive from outside the Dashboard; post them with the browser's own session.
  const propose = (body: unknown) =>
    page.evaluate(async (b) => {
      const res = await fetch("/api/v1/memory/proposals", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-attache-client": "1" }, body: JSON.stringify(b) });
      if (!res.ok) throw new Error(`propose failed: ${res.status} ${await res.text()}`);
      return (await res.json()) as { id: string };
    }, body);
  const update = await propose({
    item: {
      action: "update",
      path: VENDOR,
      facts: [
        { subject: "Decision", value: "Use Postmark from January 2027", reason: "Contract signed" },
        { subject: "Owner", value: "Procurement", reason: "Named in the contract" },
      ],
      events: ["Postmark contract signed"],
    },
    reason: "Vendor review session",
    source: { kind: "agent-session", ref: "claude-code/sess-e2e", label: "Claude Code session in attache" },
    evidence: "Procurement signed the Postmark contract this morning.",
  });
  const create = await propose({ item: { action: "create", type: "person", title: "Lena Berg", facts: [{ subject: "Role", value: "Postmark account manager" }], tags: ["vendor"] }, reason: "Introduced in the vendor call" });

  const review = page.getByRole("region", { name: /Changes to the Brain/ });
  const card = review.locator(`[data-proposal="${update.id}"]`);
  await expect(card.getByText(`Update ${VENDOR}`)).toBeVisible();
  // A fact the note already holds with another value shows as a correction: the old value and the new one.
  await expect(card.locator('[data-part="correction"]')).toHaveText([/Correction\s*Decision: Switch to Postmark for 2027 → Use Postmark from January 2027 \(Contract signed\)/]);
  await expect(card.locator('[data-part="correction"] del')).toHaveText("Switch to Postmark for 2027");
  await expect(card.locator('[data-part="fact"]')).toHaveText([/Owner: Procurement \(Named in the contract\)/]);
  await expect(card.locator('[data-part="event"]')).toHaveText([/Postmark contract signed/]);
  await expect(card.locator("[data-evidence]")).toHaveText(/Evidence\s*Procurement signed the Postmark contract this morning\./);
  await expect(card).toContainText("Why: Vendor review session");
  await expect(card).toContainText("Source: Claude Code session in attache");
  const newNote = review.locator(`[data-proposal="${create.id}"]`);
  await expect(newNote.getByText("New person: Lena Berg")).toBeVisible();
  await expect(newNote.locator('[data-part="tags"]')).toContainText("vendor");

  await card.getByRole("button", { name: "Apply" }).click();
  await expect(card).toHaveCount(0);
  await newNote.getByRole("button", { name: "Reject" }).click();
  await expect(review.locator("[data-proposal]")).toHaveCount(0);
  await expect(review).toContainText("No changes to review");

  const file = readFileSync(join(stack.dataDir, VENDOR), "utf8");
  const [current, history] = file.split("## History");
  expect(current).toContain("Use Postmark from January 2027");
  expect(current).toContain("**Owner**");
  expect(history).toContain('**Decision** was "Switch to Postmark for 2027"');
  expect(history).toContain("Postmark contract signed");
  expect(existsSync(join(stack.dataDir, "memory/people/lena-berg.md"))).toBe(false);
  await page.goto(`${stack.url}/brain?path=${encodeURIComponent(VENDOR)}&tab=decision`);
  await expect(page.locator('[data-subject="Decision"]')).toContainText("Use Postmark from January 2027");
});

test("recent saves: each save shows its Harness and session, and one click reverts it", async () => {
  const save = (items: unknown[], agent: string, session: string) => harnessSave(stack, items, { agent, session });
  const atlas = "memory/projects/atlas-launch.md";
  await save([{ action: "create", type: "project", title: "Atlas launch", facts: [{ subject: "Launch date", value: "14 October" }, { subject: "Owner", value: "Ada" }] }], "claude-code", "sess-e2e-1");
  await save([{ action: "update", path: atlas, facts: [{ subject: "Launch date", value: "21 October", reason: "vendor slip" }, { subject: "Owner", value: "Grace", reason: "handover" }] }], "claude-code", "sess-e2e-2");
  await save([{ action: "update", path: atlas, facts: [{ subject: "Owner", value: "Linus", reason: "second handover" }] }], "codex", "thread-e2e-3");
  await save([{ action: "create", type: "note", title: "Quasar pricing idea", facts: [{ subject: "Idea", value: "Charge per seat" }] }], "codex", "thread-e2e-4");

  const page = await journeys.open("/brain");
  const recent = page.getByRole("region", { name: "Recent saves" });
  const row = (text: string | RegExp) => recent.getByRole("listitem").filter({ hasText: text });
  await expect(recent).toBeVisible();
  // The newest few show first; the rest are one click away.
  await expect(recent.getByRole("listitem")).toHaveCount(5);
  await recent.getByRole("button", { name: /Show all \d+/ }).click();
  const launchId = await row("21 October").getAttribute("data-change");
  const launch = recent.locator(`[data-change="${launchId}"]`);
  await expect(launch).toContainText("Launch date");
  await expect(launch.locator("del")).toHaveText("14 October");
  await expect(launch).toContainText("Claude Code, session sess-e2e-2");
  await expect(launch.locator("time")).toBeVisible();

  // A change a later change overwrote cannot be reverted, and the Dashboard says why.
  const grace = row(/→\s*Grace/);
  await expect(grace).toContainText("A later change overwrote “Owner”. Revert that change first.");
  await expect(grace.getByRole("button", { name: "Revert" })).toHaveCount(0);

  await launch.getByRole("button", { name: "Revert" }).click();
  await expect(page.getByText("Reverted. The revert is listed as a change of its own.")).toBeVisible();
  const revert = recent.getByRole("listitem").first();
  await expect(revert).toContainText("revert");
  await expect(revert).toContainText("Revert in the Dashboard");
  await expect(revert.locator("ins")).toHaveText("14 October");
  await expect(launch).toContainText("reverted");
  const note = readFileSync(join(stack.dataDir, atlas), "utf8");
  expect(note).toMatch(/- \*\*Launch date\*\* \(\d{4}-\d{2}-\d{2}\): 14 October/);
  expect(note.split("## History")[1]).toMatch(/was "14 October"[\s\S]*was "21 October"/);

  // Reverting a created note removes it from the Brain and from search.
  await row("Created the note").filter({ hasText: "Quasar pricing idea" }).getByRole("button", { name: "Revert" }).click();
  await expect(row("Removed the note").filter({ hasText: "Quasar pricing idea" })).toBeVisible();
  expect(existsSync(join(stack.dataDir, "memory/notes/quasar-pricing-idea.md"))).toBe(false);
  await page.getByRole("searchbox", { name: "Search the Brain" }).fill("Quasar");
  await expect(page.getByText("No matches")).toBeVisible();
});

/** Where a tab sits in its tab bar: its row, and whether the bar shows all of it. */
async function tabPlaces(tablist: Locator) {
  return tablist.evaluate((list) => {
    const bar = list.getBoundingClientRect();
    return [...list.querySelectorAll('[role="tab"]')].map((tab) => {
      const box = tab.getBoundingClientRect();
      return { name: tab.textContent, top: Math.round(box.top), height: box.height, shown: box.left >= bar.left - 0.5 && box.right <= bar.right + 0.5 };
    });
  });
}

/** Holds back the Inter font until the returned function is called, so the page lays out in the fallback font first. */
async function holdInter(page: Page): Promise<() => void> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/assets\/inter-latin-wght-normal-[\w-]+\.woff2$/, (route) => released.then(() => route.continue()), { times: 1 });
  return release;
}

/** The first character of every line an element's text runs onto. */
function lineStarts(el: Element): string[] {
  const starts = new Map<number, { left: number; char: string }>();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    for (let i = 0; i < text.length; i++) {
      if (!text[i]!.trim()) continue;
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const box = range.getBoundingClientRect();
      const line = Math.round(box.top);
      const first = starts.get(line);
      if (!first || box.left < first.left) starts.set(line, { left: box.left, char: text[i]! });
    }
  }
  return [...starts.values()].map((s) => s.char);
}

test("narrow layout: the Connections page has one name in the masthead, the More sheet and its heading", async () => {
  const page = await journeys.open("/connections");
  const masthead = page.locator(".masthead-nav");
  const bottom = page.locator(".bottom-bar");
  const more = page.getByRole("dialog", { name: "More" });
  // One name for the page in the masthead, the More sheet and the heading.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connections");
  await expect(masthead.getByRole("link", { name: "Connections", exact: true })).toBeVisible();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(bottom).toBeVisible();
    await bottom.getByRole("button", { name: "More" }).click();
    await expect(more.getByRole("link", { name: "Connections", exact: true })).toBeVisible();
    await expect(more.getByRole("link", { name: "Sources" })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Sources" })).toHaveCount(0);
    // Every label shows in full, without an ellipsis, and the bar fits the window.
    const clipped = await bottom.locator("a, button").evaluateAll((links) => links.filter((a) => a.scrollWidth > a.clientWidth).map((a) => a.textContent));
    expect(clipped, `bottom bar labels cut off at ${width}px`).toEqual([]);
    expect(await bottom.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `bottom bar fits at ${width}px`).toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await bottom.getByRole("link", { name: "Brain" }).click();
  await bottom.getByRole("button", { name: "More" }).click();
  await more.getByRole("link", { name: "Connections" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connections");
});

test("narrow layout: the Brain's collection tabs keep one row and scroll sideways, on a phone and in a wide window's list column", async () => {
  const page = await journeys.open("/brain");
  for (const viewport of [{ width: 390, height: 844 }, { width: 1024, height: 800 }, { width: 1360, height: 900 }]) {
    const at = `at ${viewport.width}px`;
    await page.setViewportSize(viewport);
    await page.goto(`${stack.url}/brain?tab=person`);
    const tablist = page.getByRole("tablist", { name: "Collection" });
    await expect(tablist.getByRole("tab", { name: "People" })).toHaveAttribute("aria-selected", "true");
    const places = await tabPlaces(tablist);
    expect(new Set(places.map((p) => p.top)).size, `collection tabs on one row ${at}`).toBe(1);
    expect((await tablist.boundingBox())!.height, `the tab bar is one tab high ${at}`).toBeLessThanOrEqual(places[0]!.height + 1);
    const box = (await tablist.boundingBox())!;
    expect(box.x + box.width, `the tab bar stays inside the window ${at}`).toBeLessThanOrEqual(viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `no horizontal overflow ${at}`).toBeLessThanOrEqual(0);
    // The tabs that do not fit are one sideways scroll away, and the bar shows there are more.
    const more = page.locator(".tabs-scroll.after");
    const back = page.locator(".tabs-scroll.before");
    expect(places.find((p) => p.name === "Deliverables")!.shown, `Deliverables is out of view ${at}`).toBe(false);
    await expect(more).toBeVisible();
    await expect(back).toBeHidden();
    await more.click();
    await expect.poll(async () => (await tabPlaces(tablist)).find((p) => p.name === "Deliverables")!.shown, `scrolled to Deliverables ${at}`).toBe(true);
    await expect(back).toBeVisible();
    await tablist.getByRole("tab", { name: "Deliverables" }).click();
    await expect(tablist.getByRole("tab", { name: "Deliverables" })).toHaveAttribute("aria-selected", "true");
    // Opened from a link, the selected tab is in view, and stays in view when Inter arrives after the tabs were laid out in the fallback font.
    const releaseFont = await holdInter(page);
    await page.goto(`${stack.url}/brain?tab=deliverables`, { waitUntil: "commit" });
    await expect(tablist.getByRole("tab", { name: "Deliverables" })).toHaveAttribute("aria-selected", "true");
    expect(await page.evaluate(() => document.fonts.check('14px "Inter"')), `the tabs are laid out before Inter arrives ${at}`).toBe(false);
    releaseFont();
    await expect.poll(() => page.evaluate(() => document.fonts.check('14px "Inter"')), `Inter arrives ${at}`).toBe(true);
    await expect.poll(async () => (await tabPlaces(tablist)).find((p) => p.name === "Deliverables")!.shown, `Deliverables in view when opened ${at}`).toBe(true);
    // The list follows the tabs at the same distance as the tabs follow the search box.
    await page.goto(`${stack.url}/brain?tab=project`);
    await expect(page.locator(".split .list-item").first()).toBeVisible();
    const search = (await page.getByRole("searchbox", { name: "Search the Brain" }).boundingBox())!;
    const bar = (await page.locator(".tabs-bar").filter({ has: tablist }).boundingBox())!;
    const list = (await page.locator(".split .list-item").first().boundingBox())!;
    expect(Math.round(list.y - (bar.y + bar.height)), `gap below the collection tabs ${at}`).toBe(Math.round(bar.y - (search.y + search.height)));
  }
});

test("narrow layout: a picked note opens in view, Recent saves never start a line with a dot, and research gets a whole row", async () => {
  const page = await journeys.open("/brain");

  // On a phone the note opens below the list, and picking one brings it into view.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${stack.url}/brain?tab=project`);
  await page.locator(".split .list-item", { hasText: "Atlas launch" }).click();
  await expect(page.getByRole("heading", { name: "Atlas launch", level: 2 })).toBeVisible();
  // The note starts at the top of the window, or, when the page ends first, shows in full above the bottom bar.
  const noteInView = () =>
    page.locator(".split-detail").evaluate((note) => {
      const box = note.getBoundingClientRect();
      return box.top <= 80 || box.bottom <= document.querySelector(".bottom-bar")!.getBoundingClientRect().top;
    });
  await expect.poll(noteInView, "the picked note is in view").toBe(true);

  // A wrapped Recent saves line starts with its words, never with a separator dot.
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(`${stack.url}/brain`);
  const metas = page.getByRole("region", { name: "Recent saves" }).locator(".recent-change-meta");
  await expect(metas.first()).toBeVisible();
  for (const meta of await metas.all()) expect(await meta.evaluate(lineStarts)).not.toContain("·");

  // The research question gets the whole row on a phone instead of a sliver beside the buttons.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${stack.url}/jobs`);
  const question = page.getByRole("textbox", { name: "Research question" });
  const form = await question.evaluate((input) => {
    const f = input.closest("form")!;
    const s = getComputedStyle(f);
    return { width: f.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight), input: input.getBoundingClientRect().width };
  });
  expect(form.input, "research question width").toBeGreaterThanOrEqual(form.width - 1);
  await expect(page.getByRole("button", { name: "Research", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Diagnostics", exact: true })).toBeVisible();
});

test("review dates: a fact shows its Review date, and one past it is marked unverified", async () => {
  const rel = "memory/projects/helix-rollout.md";
  const inAMonth = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  await harnessSave(stack, [{ action: "create", type: "project", title: "Helix rollout", facts: [{ subject: "Status", value: "Helix pilot in two stores", review: inAMonth }, { subject: "Budget", value: "Helix budget is 40k EUR" }] }], { agent: "claude-code", session: "sess-e2e-review" });
  // An edit by hand: the budget was due for review long ago.
  const file = join(stack.dataDir, rel);
  writeFileSync(file, readFileSync(file, "utf8").replace(/\*\*Budget\*\* \(\d{4}-\d{2}-\d{2}\)/, "**Budget** (2026-01-10, review 2026-02-01)"));

  const page = await journeys.open(`/brain?path=${encodeURIComponent(rel)}&tab=project`);
  const status = page.locator('[data-subject="Status"]');
  const budget = page.locator('[data-subject="Budget"]');
  await expect(status).toContainText(`review after ${inAMonth}`);
  await expect(status).not.toContainText("unverified");
  await expect(budget).toContainText("unverified");
  await expect(budget).toContainText("review was due 2026-02-01");

  await page.getByRole("searchbox", { name: "Search the Brain" }).fill("Helix budget");
  const hit = page.locator(".list-item", { hasText: "40k EUR" }).first();
  await expect(hit).toContainText("unverified");

  // Refreshing the data folder raises one inbox item for the overdue fact, and none for the other.
  await page.goto(`${stack.url}/connections`);
  await page.locator('[data-connection="vault-data"]').getByRole("button", { name: "Refresh now" }).click();
  await expect(page.getByText("Refresh started")).toBeVisible();
  await page.goto(`${stack.url}/`);
  const facts = page.getByRole("region", { name: "Facts to check" });
  await expect(facts.getByText("Review date passed: “Budget” in Helix rollout")).toBeVisible();
  await expect(facts.getByText(/“Status” in Helix rollout/)).toHaveCount(0);
});

test("reconnect: a claude.ai connector that loses sign-in offers Reconnect, which restores it", async () => {
  const setServer = (status: string) =>
    fetch(`${stack.fixtureUrl}/__control/claude-server`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "claude.ai Slack", status }) });
  // Connect, Test and Reconnect each start the fake Claude Code CLI, which is slow while other suites load the Machine.
  const cliRun = { timeout: 30_000 };
  const page = await journeys.open("/connections");
  const slack = page.locator('[data-connection="slack"]');
  // On the full Connections page an unconfigured card opens straight into its setup form.
  await expect(slack.getByText("not connected", { exact: true })).toBeVisible();
  await slack.getByRole("button", { name: "Connect" }).click();
  await expect(slack.getByText("connected", { exact: true })).toBeVisible(cliRun);

  // The connector is signed out in claude.ai: the card says so and offers Reconnect, not just Reconfigure.
  await setServer("needs-auth");
  await slack.getByRole("button", { name: "Test" }).click();
  await expect(slack.getByText("needs auth", { exact: true })).toBeVisible(cliRun);
  const callout = slack.getByRole("status", { name: "Sign-in needed" });
  await expect(callout).toContainText("claude.ai → Settings → Connectors");
  // The masthead counts the sign-in beside Connections.
  const connectionsLink = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Connections/ });
  await expect(connectionsLink).toHaveAccessibleName("Connections, 1 sign-in needed");
  await expect(connectionsLink.locator(".count")).toHaveText("1");

  // Reconnecting before the sign-in is fixed says what is still wrong.
  await callout.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.getByText(/Still not signed in: Slack is not connected in claude.ai/)).toBeVisible(cliRun);
  await expect(slack.getByText("needs auth", { exact: true })).toBeVisible();

  await setServer("connected");
  await callout.getByRole("button", { name: "Reconnect" }).click();
  // The toast lasts a few seconds from the moment the test passes, which can be before the card has reloaded, so it is checked first.
  await expect(page.getByText("Reconnected")).toBeVisible();
  await expect(slack.getByText("connected", { exact: true })).toBeVisible(cliRun);
  await expect(slack.getByRole("status", { name: "Sign-in needed" })).toHaveCount(0);
  await expect(connectionsLink).toHaveAccessibleName("Connections");
});

/** Select Check now and wait until the check has finished: the button reads "Checking…" meanwhile. */
async function checkNow(card: Locator) {
  await card.getByRole("button", { name: "Check now" }).click();
  await expect(card.getByRole("button", { name: "Check now" })).toBeEnabled();
}

test("replication: set up in Settings, joined from another Machine's setup, watched, blocked with its cause, and switched off", async ({ browser }) => {
  const remote = createBareRemote();
  const page = await journeys.open("/settings");
  const card = page.getByRole("region", { name: "Replication" });
  await expect(card.getByText("off", { exact: true })).toBeVisible();
  await card.getByRole("textbox", { name: "Repository" }).fill(remote);
  await card.getByRole("button", { name: "Set up Replication" }).click();
  await expect(card.getByText("up to date", { exact: true })).toBeVisible();
  await expect(card.locator("[data-up-to-date]")).toHaveText("just now");
  await expect(card.locator(".machine-row")).toHaveCount(1);
  await expect(card.locator('[data-machine="Home PC"]')).toContainText("this Machine");

  // A second Machine joins from its own setup screen, into an empty folder.
  const other = await startStack();
  const otherCtx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  try {
    const second = await otherCtx.newPage();
    journeys.watch(second);
    await second.goto(other.pairUrl());
    const dataFolder = second.getByRole("textbox", { name: /Data folder/ });
    await second.getByText("Already use Attache on another Machine?").click();
    const repository = second.getByRole("textbox", { name: "Repository" });
    // With both empty, Setup's data folder comes first: it sits above the Join form.
    await dataFolder.fill("");
    await second.getByRole("button", { name: "Join into this folder" }).click();
    await expect(dataFolder).toBeFocused();
    await expect(dataFolder).toHaveAccessibleDescription(/Enter an empty folder for the Brain\./);
    await expect(repository).toHaveAttribute("aria-invalid", "true");
    await dataFolder.fill(other.dataDir);
    await second.getByRole("button", { name: "Join into this folder" }).click();
    await expect(repository).toBeFocused();
    await expect(repository).toHaveAccessibleDescription(/Enter the repository your other Machine replicates to\./);
    // A repository the service refuses is named beside the field, which gets focus again.
    await repository.fill("not a repository");
    await second.getByRole("button", { name: "Join into this folder" }).click();
    await expect(repository).toHaveAttribute("aria-invalid", "true");
    await expect(repository).toBeFocused();
    await repository.fill(remote);
    await expect(repository).not.toHaveAttribute("aria-invalid", "true");
    await second.getByRole("button", { name: "Join into this folder" }).click();
    await expect(second.getByRole("heading", { name: "Choose what Attache does" })).toBeVisible();
    expect(readFileSync(join(other.dataDir, "memory/self.md"), "utf8")).toContain("Test User");
    await second.evaluate(() => fetch("/api/v1/setup/complete", { method: "POST", credentials: "same-origin", headers: { "x-attache-client": "1" } }));
    await second.goto(`${other.url}/settings`);
    const machineCard = second.locator(".card", { has: second.getByRole("heading", { name: "This Machine" }) });
    await machineCard.getByRole("textbox", { name: "Name" }).fill("Work Mac");
    await machineCard.getByRole("button", { name: "Rename" }).click();
    const theirs = second.getByRole("region", { name: "Replication" });
    await expect(theirs.getByText("up to date", { exact: true })).toBeVisible();
    await expect(theirs.locator('[data-machine="Work Mac"]')).toContainText("this Machine");
    await expect(theirs.locator('[data-machine="Home PC"]')).toBeVisible();
    // Standby and the Preferred Reader are chosen here and recorded in the Brain.
    await theirs.getByRole("checkbox", { name: /Standby/ }).click();
    await expect(theirs.getByRole("checkbox", { name: /Standby/ })).toBeChecked();
    await expect(theirs.locator('[data-machine="Work Mac"]')).toContainText("standby");
    await theirs.getByRole("combobox", { name: "Preferred Reader" }).selectOption({ label: "Home PC" });
    await expect(theirs.locator('[data-machine="Home PC"]')).toContainText("Preferred Reader");
    await checkNow(theirs);
    await expect(theirs.getByText("up to date", { exact: true })).toBeVisible();

    // The first Machine sees the second, its standby flag and the Preferred Reader.
    await checkNow(card);
    await expect(card.locator('[data-machine="Work Mac"]')).toContainText("standby");
    await expect(card.locator('[data-machine="Home PC"]')).toContainText("Preferred Reader");
    await expect(card.getByRole("combobox", { name: "Preferred Reader" })).toHaveValue(/[0-9a-f-]{36}/);

    // A file both Machines changed with no merge rule blocks Replication; the Dashboard says why and what to do.
    writeFileSync(join(other.dataDir, "plan.txt"), "from the Work Mac\n");
    await checkNow(theirs);
    await expect(theirs.getByText("up to date", { exact: true })).toBeVisible();
    writeFileSync(join(stack.dataDir, "plan.txt"), "from the Home PC\n");
    await checkNow(card);
    await expect(card.getByText("blocked", { exact: true })).toBeVisible();
    // Settings carries the named warning in the masthead, from every screen.
    const settingsLink = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Settings/ });
    await expect(settingsLink).toHaveAccessibleName("Settings, Replication blocked");
    const problem = card.locator("[data-replication-problem]");
    await expect(problem).toContainText("Replication is blocked");
    await expect(problem).toContainText("plan.txt");
    await expect(problem).toContainText("What to do:");
    writeFileSync(join(stack.dataDir, "plan.txt"), "from the Work Mac\n");
    await checkNow(card);
    await expect(card.getByText("up to date", { exact: true })).toBeVisible();
    await expect(problem).toHaveCount(0);
    await expect(settingsLink).toHaveAccessibleName("Settings");

    // Both Machines name the Reader, here the Machine that set Replication up, and when it last refreshed every source.
    await expect(card.locator('[data-machine="Home PC"]').getByText("Reader", { exact: true })).toBeVisible();
    await second.goto(`${other.url}/`);
    const readerLine = second.locator(".page .reader-line");
    await expect(readerLine).toHaveAttribute("data-reader", "other");
    await expect(readerLine).toContainText("Home PC runs Source refresh and briefings.");
    await expect(readerLine).toContainText("Last Source refresh");
    // The masthead's disclosure names this Machine and the Reader.
    await second.getByRole("button", { name: /^This Machine/ }).click();
    const machinePanel = second.getByRole("region", { name: "This Machine" });
    await expect(machinePanel).toContainText("Work Mac");
    await expect(machinePanel.locator(".reader-line")).toContainText("Home PC runs Source refresh and briefings.");
  } finally {
    await otherCtx.close();
    await other.stop();
  }

  // Switching off asks first, then leaves the Brain in the data folder.
  await card.getByRole("button", { name: "Switch off" }).click();
  await expect(card.getByText("Switch Replication off on this Machine?")).toBeVisible();
  await card.getByRole("group", { name: "Switch Replication off" }).getByRole("button", { name: "Switch off" }).click();
  await expect(card.getByText("off", { exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "Set up Replication" })).toBeVisible();
  expect(readFileSync(join(stack.dataDir, "memory/self.md"), "utf8")).toContain("Test User");
  expect(existsSync(join(stack.dataDir, ".git"))).toBe(true);
  // Without Replication this Machine is its own Reader again.
  await page.goto(`${stack.url}/`);
  await expect(page.locator(".page .reader-line")).toHaveAttribute("data-reader", "alone");
  await expect(page.locator(".page .reader-line")).toContainText("This Machine runs Source refresh and briefings.");
});

test("wording: no view says sync for reading sources; a source offers Refresh now", async () => {
  const page = await journeys.open("/connections");
  const gh = page.locator('[data-connection="github"]');
  await expect(gh.getByRole("button", { name: "Refresh now" })).toBeVisible();
  await gh.getByRole("button", { name: "Refresh now" }).click();
  await expect(page.getByText("Refresh started")).toBeVisible();
  for (const path of ["/", "/brain", "/approvals", "/jobs", "/connections", "/settings"]) {
    await page.goto(`${stack.url}${path}`);
    await expect(page.getByRole("navigation", { name: "Main" }).first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    const text = await page.locator("body").innerText();
    expect(text, `"sync" on ${path}`).not.toMatch(/\bsync/i);
  }
});

test("wording: connection help shows commands as code and addresses as links", async () => {
  const page = await journeys.open("/connections");
  const jira = page.locator('[data-connection="jira"]');
  await expect(jira.locator("label", { hasText: "Connector name in Claude Code" }).locator("code")).toHaveText("claude mcp list");
  await jira.getByRole("combobox", { name: "How to connect" }).selectOption("api-token");
  const link = jira.locator("label", { hasText: /^API token/ }).getByRole("link");
  await expect(link).toHaveAttribute("href", /^https:\/\/id\.atlassian\.com\/manage-profile\/security\/api-tokens\?/);
  await expect(link).toHaveText("Create a token");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(jira).not.toContainText("`");
});

test("wording: on Linux and Windows no view names macOS, and example folders are on this computer", async () => {
  const page = await journeys.open("/settings");
  await expect(page.getByRole("checkbox", { name: "Desktop notification for new urgent items" })).toBeVisible();
  await page.getByRole("tab", { name: "Join another Machine" }).click();
  await expect(page.getByRole("textbox", { name: /Empty folder for the Brain/ })).toHaveAttribute("placeholder", join(DOCUMENTS, "Brain"));
  await expectNoMacWording(page, "/settings");
  await page.goto(`${stack.url}/connections`);
  await expect(page.getByRole("textbox", { name: "Folder path" })).toHaveAttribute("placeholder", join(DOCUMENTS, "Notes"));
  await expectNoMacWording(page, "/connections");
});

test("no unresolved console errors across journeys", () => {
  expect(journeys.consoleErrors).toEqual([]);
});
