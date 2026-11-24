import { test, expect, type Page, type BrowserContextOptions, type BrowserType, type Locator } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { JourneyBrowser } from "./browser.ts";
import { connection, openConnection } from "./connections.ts";
import { approvalRow, approvalRowById, draftsGroup, openApprovalRow, proposalsGroup } from "./approvals.ts";
import { buildAll, endApproval, harnessSave, startStack, type Stack } from "./stack.ts";
import { lineStarts } from "./layout.ts";
import { inboxRow, inboxView, openRow } from "./inbox.ts";
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
  await expect(page.getByRole("heading", { level: 2, name: "Inbox" })).toBeVisible();
  await expect(inboxRow(page, "Review rollback runbook")).toContainText("Overdue");
  await expect(inboxRow(page, "Add checkout retry")).toContainText("GitHub · acme/web #42", { timeout: 20_000 });
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

test("home: search and the inbox, with no chat box or chat shortcut", async () => {
  const page = await journeys.open("/");
  await expect(page.getByRole("heading", { level: 2, name: "Inbox" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Attache" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Conversation" })).toHaveCount(0);
  await expect(page.getByRole("separator")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main" }).first()).not.toContainText("ask");
  // `/` used to jump to the chat box; now it searches the Brain (home-search.spec.ts has the whole of it).
  await page.keyboard.press("/");
  await expect(page.getByRole("combobox", { name: "Search the Brain" })).toBeFocused();
  await expect(page).toHaveURL(`${stack.url}/`);
});

test("Connections: healthy has a green dot, a failed check shows Retry, and a silent Reader shows one banner", async () => {
  const page = await journeys.open("/");
  const banner = page.locator("[data-connection-banner]");
  await expect(banner).toHaveCount(0);
  await expect(page.locator(".masthead-nav").getByRole("link", { name: "Connections" }).locator(".connection-healthy-dot")).toBeVisible();
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Connections" }).click();
  await expect(page).toHaveURL(`${stack.url}/connections`);
  await page.goto(`${stack.url}/connections?open=github`);
  await expect(page.locator('[data-connection="github"] :focus')).toHaveCount(1);

  await page.route("**/api/v1/reader", (route) => route.abort());
  await page.goto(`${stack.url}/`);
  const failed = page.locator('[data-connection-banner][data-state="could_not_check"]');
  await expect(failed).toContainText("Could not check");
  await page.unroute("**/api/v1/reader");
  await failed.getByRole("button", { name: "Retry" }).click();
  await expect(banner).toHaveCount(0);

  await page.route("**/api/v1/reader", async (route) => {
    const res = await route.fetch();
    const reader = await res.json();
    await route.fulfill({ response: res, json: { ...reader, replicated: true, silent: true, thisMachine: false, machine: { id: "other", name: "Home PC" }, heartbeatAt: new Date(Date.now() - 2 * 3_600_000).toISOString() } });
  });
  await page.reload();
  const notReading = page.locator('[data-connection-banner][data-state="not_reading"]');
  await expect(notReading).toContainText("Home PC · Not reading · New items may be missing");
  await expect(page.locator("[data-reader-warning]")).toHaveCount(0);
  await expect(notReading.getByRole("link", { name: "Machines and Replication" })).toHaveAttribute("href", "/settings/machines");
  await page.unroute("**/api/v1/reader");
  await page.close();
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
  await expect(page.getByRole("heading", { level: 2, name: "Inbox" })).toBeVisible();
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
  await expect(page.getByRole("heading", { level: 2, name: "Inbox" })).toBeVisible();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // Opened from the keyboard, as a mouse click would leave the next focus without its ring (`:focus-visible`).
    const first = page.locator("#inbox [data-inbox-row]").first();
    if ((await first.locator("[data-row-toggle]").getAttribute("aria-expanded")) !== "true") await first.locator("[data-row-toggle]").press("Enter");
    const onCard = first.locator(".inbox-row-actions").getByRole("button", { name: /^(Start working|Continue):/ });
    const onCanvas = page.locator("#inbox").getByRole("button", { name: /^View options/ });
    const onQuiet = page.getByRole("region", { name: "The Daily Briefing" }).getByRole("button", { name: "Briefing options" });
    // Control edges: a secondary button on a card and on the canvas.
    for (const control of [onCard, onQuiet, onCanvas]) {
      const edge = await measure(control, "border");
      expect(edge, `${scheme} control edge`).toMatchObject({ width: 1, style: "solid" });
      expect(edge.ratio, `${scheme} control edge`).toBeGreaterThanOrEqual(3);
    }
    // The focus ring: a 3 px outline (never a fill like a selection), at 3:1 or better on every surface it lands on.
    for (const control of [onCard, onCanvas, onQuiet]) {
      await control.focus();
      const ring = await measure(control, "outline");
      expect(ring, `${scheme} focus ring`).toMatchObject({ width: 3, style: "solid" });
      expect(ring.ratio, `${scheme} focus ring`).toBeGreaterThanOrEqual(3);
    }
    // A healthy state is the green masthead dot and no banner, never a coloured pill.
    await expect(page.locator("[data-connection-banner]")).toHaveCount(0);
    await expect(page.locator(".masthead-nav .connection-healthy-dot")).toBeVisible();
  }
  await page.close();
});

test("search: a hit opens the exact evidence lines, keyboard", async () => {
  const page = await journeys.open("/brain");
  const search = page.getByRole("searchbox", { name: "Search the Brain" });
  await search.fill("When is the cutover plan due for the Orion migration?");
  const hit = page.locator(".result-item", { hasText: "Orion" }).first();
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

test("attention: a decided row stays in place with Undo; dismiss and snooze persist across reload and briefings", async () => {
  const page = await journeys.open("/");
  const runbook = inboxRow(page, "Review rollback runbook");
  await openRow(runbook);
  await runbook.getByRole("button", { name: "Dismiss" }).click();
  // The row stays where it was as one line, with Undo focused, so nothing below it moves.
  await expect(runbook).toHaveAttribute("data-decided", "dismiss");
  await expect(runbook).toContainText("Dismissed: Review rollback runbook");
  await expect(runbook.getByRole("button", { name: "Undo" })).toBeFocused();
  // Undo brings the item back in the same place; dismissing again sticks.
  await runbook.getByRole("button", { name: "Undo" }).click();
  await expect(runbook).not.toHaveAttribute("data-decided");
  await expect(runbook.locator("[data-row-toggle]")).toBeFocused();
  await openRow(runbook);
  await runbook.getByRole("button", { name: "Dismiss" }).click();
  await expect(runbook).toHaveAttribute("data-decided", "dismiss");
  const cutover = inboxRow(page, "Send the cutover plan to finance");
  await openRow(cutover);
  await cutover.locator(".inbox-detail").getByRole("button", { name: "Snooze" }).click();
  await cutover.locator(".inbox-detail").getByRole("group", { name: "Snooze until" }).getByRole("button", { name: "1 hour" }).click();
  await expect(cutover).toHaveAttribute("data-decided", "snooze");
  const briefing = page.getByRole("region", { name: "The Daily Briefing" });
  await briefing.getByRole("button", { name: "Briefing options" }).click();
  await briefing.getByRole("group", { name: "Briefing actions" }).getByRole("button", { name: /^Prepare a briefing/ }).click();
  // With no Daily Briefing yet today, Prepare a briefing writes it: its card fills the area, Read briefing opens it as a
  // page with its points, and a Top to-do there opens its Inbox item in place on Home.
  await briefing.locator(".daily-briefing-card").getByRole("link", { name: "Read briefing" }).click({ timeout: 30_000 });
  await expect(page).toHaveURL(/\/briefing\/[^/]+$/);
  await expect(page.locator(".briefing-lines li").first()).toBeVisible();
  const todo = page.locator(".briefing-page-section", { has: page.getByRole("heading", { name: "Top to-dos" }) }).locator("[data-briefing-entry=inbox]").first();
  const todoId = await todo.getAttribute("data-item-id");
  await todo.locator(".briefing-item-title").click();
  await expect(page).toHaveURL(`${stack.url}/`);
  const opened = page.locator(`#inbox [data-inbox-row][data-item-id="${todoId}"]`);
  await expect(opened.locator("[data-row-toggle]")).toHaveAttribute("aria-expanded", "true");
  await expect(opened).toBeInViewport();
  await page.reload();
  await expect(inboxRow(page, "Add checkout retry")).toBeVisible();
  // The logo's dot says something needs attention.
  await expect(page.locator(".masthead .brand .logo-dot")).toHaveCount(1);
  await expect(inboxRow(page, "Review rollback runbook")).toHaveCount(0);
  await expect(inboxRow(page, "Send the cutover plan to finance")).toHaveCount(0);
  await inboxView(page, "Hidden");
  await expect(inboxRow(page, "Review rollback runbook")).toContainText("Dismissed");
  await expect(inboxRow(page, "Send the cutover plan to finance")).toContainText("Snoozed until");
  await inboxView(page, "Priority order");
  await expect(page.locator("[data-connection-banner]")).toHaveCount(0);
});

test("drafts: a rejected draft frees its item to be drafted again and stays listed as finished", async () => {
  const page = await journeys.open("/");
  const pr = inboxRow(page, "Add checkout retry");
  await openRow(pr);
  // Home's decision count sits beside the Inbox heading; with no Draft waiting every row below is a decision here.
  const needYou = page.locator("[data-need-you]");
  const countLine = page.locator(".count-line");
  await expect(needYou).toHaveText(/^\d+ needs? you here$/);
  await expect(countLine).toHaveCount(0);
  const before = Number((await needYou.textContent())!.match(/\d+/)![0]);
  await pr.getByRole("button", { name: "Prepare draft" }).click();
  await expect(pr.getByRole("button", { name: "View draft" })).toBeVisible({ timeout: 30_000 });
  // The item's decision is now its Draft's, counted once, in Approvals; the line relates the rows to the decisions.
  await expect(needYou).toHaveText(new RegExp(`^${before - 1} needs? you here$`));
  await expect(countLine).toHaveText(new RegExp(`^${before - 1} items? below needs? you · 1 Draft in Approvals$`));
  // The line speaks of the open rows, so it leaves with them when the dismissed and snoozed ones show instead.
  await inboxView(page, "Hidden");
  await expect(countLine).toHaveText("Snoozed and dismissed items. Reopen one to bring it back.");
  await inboxView(page, "Priority order");
  await expect(countLine).toHaveText(/Draft in Approvals$/);
  // The row stays in the list with its Draft's state and View draft.
  await expect(pr).toContainText("Draft waiting");
  await openRow(pr);
  await pr.getByRole("button", { name: "Start working: Add checkout retry" }).click();
  await expect(page.locator("[data-action-id]")).toHaveAttribute("data-status", "draft");
  await page.goBack();
  await expect(pr).toContainText("In progress");
  await openRow(pr);
  await pr.getByRole("button", { name: "View draft" }).click();
  const draft = page.locator("[data-action-id]");
  await expect(draft).toHaveAttribute("data-status", "draft");
  const rejectedId = await draft.getAttribute("data-action-id");
  const draftUrl = page.url();
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(draft).toHaveAttribute("data-status", "rejected");
  // The page stays on this Draft, says nothing was sent, and locks the text: only an explicit Restore undoes it.
  await expect(page).toHaveURL(draftUrl);
  await expect(page.locator(".draft-notice")).toContainText(/^You rejected v1 at \d\d:\d\d\. Nothing was sent\./);
  await expect(page.getByRole("textbox", { name: "Text of v1" })).not.toBeEditable();
  await expect(page.getByRole("button", { name: /^(Approve|Send)/ })).toHaveCount(0);
  // Reject left with the state it belonged to; focus moves to the next step instead of the page's end.
  await expect(page.getByRole("button", { name: "Restore as v2" })).toBeFocused();
  await page.getByRole("link", { name: "Home" }).click();
  await expect(pr.getByRole("button", { name: "Prepare draft" })).toBeVisible();
  await expect(pr.getByRole("button", { name: "View draft" })).toHaveCount(0);
  // The rejected Draft is finished, so the item is a decision on Home again.
  await expect(needYou).toHaveText(new RegExp(`^${before} needs? you here$`));
  await expect(countLine).toHaveCount(0);
  // Finished lists it with its outcome; it opens in place and leads to its own page.
  await page.goto(`${stack.url}/approvals`);
  await page.getByRole("tab", { name: "Finished" }).click();
  await expect(page).toHaveURL(/\/approvals\?tab=finished$/);
  const finished = approvalRowById(page, "draft", rejectedId!);
  await expect(finished.locator(".approval-meta")).toContainText("GitHub comment on acme/web #42 · v1");
  await expect(finished.locator(".tag")).toHaveText("Rejected");
  await openApprovalRow(finished);
  await finished.getByRole("link", { name: "Open the Draft" }).click();
  await expect(page).toHaveURL(new RegExp(`/approvals/${rejectedId}$`));
  await expect(page.locator("[data-action-id]")).toHaveAttribute("data-status", "rejected");
  await expect(page.getByRole("link", { name: /^Approvals/ }).first()).toHaveAttribute("aria-current", "page");
  // Restore brings the same words back as v2, on the same page; the item's decision is the Draft's again.
  const words = await page.getByRole("textbox", { name: "Text of v1" }).inputValue();
  await page.getByRole("button", { name: "Restore as v2" }).click();
  const restored = page.locator("[data-action-id]");
  await expect(restored).toHaveAttribute("data-status", "draft");
  await expect(page).toHaveURL(new RegExp(`/approvals/${rejectedId}$`));
  await expect(page.locator("[data-draft-version]")).toHaveText("v2");
  await expect(page.locator(".draft-said")).toHaveText("Restored as v2.");
  const box = page.getByRole("textbox", { name: "Text of v2" });
  await expect(box).toHaveValue(words);
  await expect(box).toBeEditable();
  await expect(page.getByRole("button", { name: "Approve v2" })).toBeFocused();
  // At 320 px the page keeps to the window: the step line, quote, text and buttons wrap instead of overflowing.
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  const steps = await page.locator(".draft-step").evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
  expect(new Set(steps).size, "the three steps share one row").toBe(1);
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.getByRole("link", { name: "Home" }).click();
  await expect(pr).toContainText("Draft waiting");
  await expect(needYou).toHaveText(new RegExp(`^${before - 1} needs? you here$`));
  // Reject it again, so the next journey prepares a Draft of its own.
  await page.goto(`${stack.url}/approvals/${rejectedId}`);
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(page.locator("[data-action-id]")).toHaveAttribute("data-status", "rejected");
});

test("drafts: prepare, edit, approve, blocked until write is authorised, then verified receipt", async () => {
  const page = await journeys.open("/");
  const pr = inboxRow(page, "Add checkout retry");
  await openRow(pr);
  await pr.getByRole("button", { name: "Prepare draft" }).click();
  await expect(pr.getByRole("button", { name: "View draft" })).toBeVisible({ timeout: 30_000 });
  await pr.getByRole("button", { name: "View draft" }).click();
  // View draft opens the Draft's own page under Approvals.
  await expect(page).toHaveURL(/\/approvals\/[^/?]+$/);
  await expect(page.getByRole("link", { name: "Back to Approvals" })).toBeVisible();
  const box = page.getByRole("textbox", { name: "Text of v1" });
  await expect(box).toHaveValue(/reviewed the changes/);
  // The header names kind, destination, version and status above the step line; the message it answers is quoted above the text.
  await expect(page.locator(".draft-destination")).toHaveText("GitHub comment on acme/web #42");
  await expect(page.locator("[data-draft-version]")).toHaveText("v1");
  await expect(page.locator(".draft-meta .tag")).toHaveText("Draft");
  await expect(page.getByRole("list", { name: "Where the Draft stands" }).getByRole("listitem")).toHaveText(["1Draft v1, current step", "2Approved, not yet", "3Sent, not yet"]);
  await expect(page.locator(".draft-quote-full")).toHaveText("Retries failed payments once.");
  const quoteBottom = (await page.locator(".draft-quote-full").boundingBox())!;
  expect(quoteBottom.y + quoteBottom.height).toBeLessThanOrEqual((await box.boundingBox())!.y);
  expect(await box.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(16);
  // Send is there before approval, disabled, with its reason.
  const send1 = page.getByRole("button", { name: "Send v1" });
  await expect(send1).toBeDisabled();
  await expect(send1).toHaveAccessibleDescription(/^Send unlocks after approval\./);
  // The citation under the Draft's context is a button: its edge reaches 3:1 on the card it sits on, in both themes.
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const edge = await measure(page.locator(".source-chip").first(), "border");
    expect(edge, `${scheme} citation edge`).toMatchObject({ width: 1, style: "solid" });
    expect(edge.ratio, `${scheme} citation edge`).toBeGreaterThanOrEqual(3);
  }
  await page.emulateMedia({ colorScheme: null });
  await box.fill("Looks good. One question: does the retry respect idempotency keys?");
  // Unsaved text: saving is the next step and says it replaces v1; Approve and Send wait.
  await expect(page.locator(".draft-notice")).toHaveText("Saving creates v2 and replaces the text of v1, which is not kept.");
  await expect(page.getByRole("button", { name: "Approve v1" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Approve v1" })).toHaveAccessibleDescription("Save or discard your changes first.");
  await page.getByRole("button", { name: "Save as v2" }).click();
  await expect(page.locator("[data-draft-version]")).toHaveText("v2");
  await page.getByRole("button", { name: "Approve v2" }).click();
  await expect(page.getByText("Cannot send yet")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send v2" })).toBeDisabled();
  await expect(page.getByRole("link", { name: "Open Connections" })).toHaveAttribute("target", "_blank");
  // Grant the separate write permission.
  await page.goto(`${stack.url}/connections`);
  const gh = await openConnection(page, "github");
  await gh.getByText(/Write permissions/).click();
  await gh.getByRole("checkbox", { name: /Post a comment/ }).check();
  await gh.getByRole("checkbox", { name: /I understand/ }).check();
  await gh.getByRole("button", { name: "Save write permissions" }).click();
  // The row's permission column names the write as soon as it is saved.
  await expect(gh.locator(".connection-permission")).toContainText("Writes post a comment on a pull request or issue");
  // Approvals lists the approved Draft under Drafts to send with its destination, version and first line. It opens in
  // place read-only, offers no Approve or Send, and leads to its own page for them.
  await page.goto(`${stack.url}/approvals`);
  const row = approvalRow(draftsGroup(page), "draft", "Add checkout retry");
  await expect(row.locator(".approval-kind")).toHaveText("Draft");
  await expect(row.locator(".approval-meta")).toContainText("GitHub comment on acme/web #42 · v2");
  await expect(row.locator(".approval-meta .tag")).toHaveText("Approved");
  await expect(row.locator(".approval-preview")).toHaveText("Looks good. One question: does the retry respect idempotency keys?");
  await openApprovalRow(row);
  await expect(row.locator(".draft-quote")).toHaveText("Retries failed payments once.");
  await expect(row.locator(".draft-text")).toHaveText("Looks good. One question: does the retry respect idempotency keys?");
  await expect(row.getByRole("textbox")).toHaveCount(0);
  await expect(row.getByRole("button", { name: /^(Approve|Send)/ })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Reject" })).toBeVisible();
  await row.getByRole("link", { name: "Review and send v2" }).click();
  await expect(page.getByRole("link", { name: "Back to Approvals" })).toBeVisible();
  // The owner steps away and the 15-minute approval ends: the draft goes back to needing approval, and approving again is one click.
  const detail = page.locator("[data-action-id]");
  await expect(detail).toHaveAttribute("data-status", "approved");
  endApproval(stack, (await detail.getAttribute("data-action-id"))!);
  await page.reload();
  await expect(detail).toHaveAttribute("data-status", "draft");
  await expect(page.getByRole("status").filter({ hasText: /^The approval of v2 ended at \d\d:\d\d\. Nothing was sent\.$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send v2" })).toBeDisabled();
  const sendingUrl = page.url();
  await page.getByRole("button", { name: "Approve v2 again" }).click();
  await expect(detail).toHaveAttribute("data-status", "approved");
  await expect(page.locator(".draft-notice")).toContainText("Send posts exactly v2 and cannot be undone.");
  await page.getByRole("button", { name: "Send v2" }).click();
  const receipt = page.locator("[data-receipt]");
  await expect(receipt).toContainText("Verified", { timeout: 20_000 });
  await expect(page.locator("[data-action-id]")).toHaveAttribute("data-status", "succeeded");
  // Sent, on the same page: every step checked, the text locked, nothing left to press but the way to the comment.
  await expect(page).toHaveURL(sendingUrl);
  await expect(page.getByRole("list", { name: "Where the Draft stands" }).getByRole("listitem").last()).toHaveText(/^Sent \d\d:\d\d, verified, done$/);
  await expect(page.getByRole("textbox", { name: "Text of v2" })).not.toBeEditable();
  await expect(page.locator("[data-draft-actions] button")).toHaveCount(0);
  await expect(page.locator("[data-draft-actions]").getByRole("link", { name: "Open on GitHub" })).toBeVisible();
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
  await expect(page2.locator("[data-job-id]").getByRole("status")).toHaveText("Stopped: the work ended before it finished.");
});

test("wording: counts read as words in the right number, never with (s)", async () => {
  const page = await journeys.open("/connections");
  await page.getByRole("button", { name: /^Import a folder/ }).click();
  await page.getByRole("textbox", { name: "Folder path" }).fill(stack.vaultDir);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByText("Reads 2 Markdown files · changes 0 files")).toBeVisible();

  await (await openConnection(page, "github")).getByRole("button", { name: "Disable…" }).click();
  const disconnect = page.getByRole("alertdialog", { name: "Disable" });
  await expect(disconnect).toContainText("Attache deletes the stored credentials and stops all requests.");
  await expect(disconnect).toContainText(/\d+ queued jobs? will be cancelled and approvals for \d+ drafts? revoked\./);
  await expect(disconnect).toContainText(/Retained data: \d+ observations?, \d+ open Inbox items?\./);
  await disconnect.getByRole("button", { name: "Cancel" }).click();
  // A notes folder has no credentials to delete, and its indexed files are counted too.
  const notes = page.locator('[data-group="notes"] .connection-row', { has: page.getByRole("button", { name: basename(stack.vaultDir), exact: true }) });
  await notes.getByRole("button", { name: basename(stack.vaultDir), exact: true }).click();
  await notes.getByRole("button", { name: "Disable…" }).click();
  await expect(disconnect).toContainText("Attache stops reading from it.");
  await expect(disconnect).not.toContainText("credentials");
  await expect(disconnect).toContainText(/Retained data: \d+ observations?, \d+ open Inbox items?, 2 indexed files\./);
  await disconnect.getByRole("button", { name: "Cancel" }).click();

  await page.goto(`${stack.url}/approvals?tab=finished`);
  const sent = approvalRow(page, "draft", "GitHub comment on acme/web #42");
  await openApprovalRow(sent);
  await sent.getByRole("link", { name: "Open the Draft" }).click();
  await expect(page.getByText("1 changed file", { exact: true })).toBeVisible();

  await page.goto(`${stack.url}/jobs`);
  await page.locator(".job-pick", { hasText: "Orion migration" }).first().click();
  await expect(page.locator('[data-event="searched"]').first()).toHaveText(/Searched “.+”: \d+ hits?$/);

  for (const path of ["/", "/brain", "/approvals", "/jobs", "/connections", "/settings"]) {
    await page.goto(`${stack.url}${path}`);
    await expect(page.getByRole("navigation", { name: "Main" }).first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    const text = await page.locator("body").innerText();
    expect(findParenthesisedPlurals(text), `counts with (s) on ${path}`).toEqual([]);
  }
});

test("feature switches: turning attention off changes the product and the backend", async () => {
  const page = await journeys.open("/settings/features");
  await page.getByRole("checkbox", { name: /^Attention and briefings/ }).click();
  await expect(page.getByRole("alert")).toContainText("Drafts and approvals needs Attention and briefings");
  await page.getByRole("button", { name: "Also turn off what depends on it" }).click();
  await expect(page.getByRole("checkbox", { name: /^Attention and briefings/ })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^Drafts and approvals/ })).not.toBeChecked();
  // Its schedule stopped: Service health's diagnostics list it as off.
  await serviceSchedules(page);
  await expect(page.getByText("Source refresh: off")).toBeVisible();
  await page.goto(stack.url);
  await expect(page.locator('#inbox [data-inbox-empty="off"]')).toContainText(/Attention and briefings is off\.\s*Nothing is read for the Inbox, so this is not a claim that nothing needs you\./);
  await page.goto(`${stack.url}/settings/features`);
  await page.getByRole("checkbox", { name: /^Drafts and approvals/ }).click();
  await page.getByRole("button", { name: "Turn on what it needs too" }).click();
  await expect(page.getByRole("checkbox", { name: /^Attention and briefings/ })).toBeChecked();
  await serviceSchedules(page);
  await expect(page.getByText(/Source refresh: next/)).toBeVisible();
});

/** Settings' Service health with its diagnostics open, where each schedule says when it runs next or that it is off. */
async function serviceSchedules(page: Page) {
  await page.goto(`${stack.url}/settings/service`);
  await page.getByText("Diagnostics", { exact: true }).click();
  await expect(page.locator("[data-diagnostics]")).toBeVisible();
}

test("this Machine: named after its hostname, renamed in Settings, and the name is kept", async () => {
  const page = await journeys.open("/settings/machines");
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
  const page = await journeys.open("/settings/service");
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
  await expect(page.locator(".result-item").first()).toBeVisible();

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
  await expect(page.locator(".result-item").first()).toBeVisible();
  await expect(page.locator("[data-keywords-only]")).toHaveCount(0);
});

test("reconnection: service restart shows on this Machine's button in the masthead, then recovers state", async () => {
  const page = await journeys.open("/");
  await expect(page.getByRole("heading", { level: 2, name: "Inbox" })).toBeVisible();
  const machine = page.getByRole("button", { name: /^This Machine/ });
  await stack.stopService();
  await expect(machine).toContainText(/Reconnecting|Disconnected/, { timeout: 20_000 });
  await stack.startService();
  await expect(machine).not.toContainText(/Reconnecting|Disconnected/, { timeout: 30_000 });
  // The Dashboard reaches the service again without a reload.
  await page.getByRole("navigation", { name: "Main" }).first().getByRole("link", { name: "Brain" }).click();
  await page.getByRole("searchbox", { name: "Search the Brain" }).fill("Priya Shah");
  await expect(page.locator(".result-item", { hasText: "Priya" }).first()).toBeVisible();
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
  await expect(page.getByRole("heading", { level: 2, name: "Inbox" })).toBeVisible();
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
        // Wide windows keep the reading columns: Home's, Settings' and Connections' columns centred beside the scrollbar, and the centred Setup steps.
        // Settings' section list sits beside its sections, across the whole reading column, as Home's does.
        if (path === "/settings") expect(s.contentWidth, `${at}: content column`).toBeGreaterThan(824);
        if (path === "/" || path === "/settings" || path === "/connections") {
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
  await page.locator(".note-list-item", { hasText: "Email vendor" }).click();
  const state = page.locator('[data-subject="Decision"]');
  await expect(state).toContainText("Switch to Postmark for 2027");
  await expect(page.getByText(/was "Keep Nimbus as email vendor for 2027"/)).toBeVisible();
  await expect(page.getByRole("button", { name: /correct|edit/i })).toHaveCount(0);
  // The note panel has nothing to type into.
  await expect(page.locator(".page textarea, .page input:not([type=search])")).toHaveCount(0);

  // Evidence and deliverables open read-only in the evidence drawer.
  for (const tab of ["Evidence", "Deliverables"]) {
    await page.getByRole("navigation", { name: "Collections" }).getByRole("link", { name: tab }).click();
    const first = page.locator(".note-list-item").first();
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
  const hit = page.locator(".result-item", { hasText: "Email vendor" }).first();
  await expect(hit).toContainText("Postmark");
  await expect(hit).not.toContainText("History");
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

  // A third Proposal corrects the same fact, from the value the first one replaces: applying the first makes it stale.
  const stale = await propose({ item: { action: "update", path: VENDOR, facts: [{ subject: "Decision", value: "Stay with Nimbus", reason: "Price" }] }, reason: "Finance call" });

  const review = proposalsGroup(page);
  // A Proposal never looks like a Draft: plum change glyph and the word Proposal, on the group and on every row.
  await expect(review.getByRole("heading", { level: 2, name: "Changes to the Brain" })).toBeVisible();
  const card = approvalRowById(page, "proposal", update.id);
  await expect(card.locator(".approval-kind")).toHaveText("Proposal");
  await expect(card.locator(".approval-kind")).toHaveClass(/c-plum/);
  // Collapsed, it names the note and the change, previous to new.
  await expect(card.locator("[data-row-toggle]")).toHaveText("Email vendor");
  await expect(card.locator(".approval-preview")).toHaveText("Decision: Switch to Postmark for 2027 → Use Postmark from January 2027 · 2 more changes");
  const newNote = approvalRowById(page, "proposal", create.id);
  await expect(newNote.locator("[data-row-toggle]")).toHaveText("Lena Berg");
  await expect(newNote.locator(".approval-meta .tag")).toHaveText("New person");
  await expect(newNote.locator(".approval-preview")).toHaveText("Role: Postmark account manager");

  // Opened in place: every part, the reason, the evidence and where it came from, then Apply and Reject.
  await openApprovalRow(card);
  await expect(card.locator('[data-part="correction"]')).toHaveText([/Correction\s*Decision: Switch to Postmark for 2027 → Use Postmark from January 2027 \(Contract signed\)/]);
  await expect(card.locator('[data-part="correction"] del')).toHaveText("Switch to Postmark for 2027");
  await expect(card.locator('[data-part="fact"]')).toHaveText([/Owner: Procurement \(Named in the contract\)/]);
  await expect(card.locator('[data-part="event"]')).toHaveText([/Postmark contract signed/]);
  await expect(card.locator("[data-evidence]")).toHaveText(/Evidence\s*Procurement signed the Postmark contract this morning\./);
  await expect(card.locator("[data-why]")).toHaveText(/Why\s*Vendor review session/);
  await expect(card).toContainText("Source: Claude Code session in attache");

  // Applied, it stays as one line in its place until the next visit, with the way to the note.
  await card.getByRole("button", { name: "Apply" }).click();
  await expect(card).toHaveAttribute("data-decided", "Applied");
  await expect(card).toContainText("Applied · Email vendor");
  await expect(card.locator(".approval-decided")).toBeFocused();
  await openApprovalRow(newNote);
  await expect(newNote.locator('[data-part="tags"]')).toContainText("vendor");
  await newNote.getByRole("button", { name: "Reject" }).click();
  await expect(newNote).toHaveAttribute("data-decided", "Rejected");

  // The stale one is refused: the reason shows in the row, Apply is off and Reject still works.
  const refused = approvalRowById(page, "proposal", stale.id);
  await openApprovalRow(refused);
  await refused.getByRole("button", { name: "Apply" }).click();
  await expect(refused.getByRole("alert")).toContainText(/Not applied\. "Decision" in memory\/decisions\/email-vendor\.md changed since this Proposal was made/);
  await expect(refused).not.toHaveAttribute("data-decided");
  await expect(refused.getByRole("button", { name: "Apply" })).toBeDisabled();
  await refused.getByRole("button", { name: "Reject" }).click();
  await expect(refused).toHaveAttribute("data-decided", "Rejected");
  await expect(page.locator('[data-approval-row="proposal"]')).toHaveCount(3);
  // The decided lines stay for the whole visit, also after a look at Finished.
  await page.getByRole("tab", { name: "Finished" }).click();
  await page.getByRole("tab", { name: /^Waiting/ }).click();
  await expect(page.locator('[data-approval-row="proposal"][data-decided]')).toHaveCount(3);
  await expect(page.getByRole("tab", { name: /^Waiting/ })).toBeFocused();

  // On the next visit the decided rows are gone, and Finished lists them with their outcomes, the latest first.
  await page.reload();
  await expect(review.getByText("No changes to the Brain wait.").or(page.getByText("Nothing waits for your OK."))).toBeVisible();
  await expect(page.locator('[data-approval-row="proposal"]')).toHaveCount(0);
  await page.getByRole("tab", { name: "Finished" }).click();
  await expect(approvalRowById(page, "proposal", update.id).locator(".tag").first()).toHaveText("Applied");
  await expect(approvalRowById(page, "proposal", stale.id).locator(".tag").first()).toHaveText("Rejected");
  const finishedIds = await page.locator('[data-approval-row="proposal"]').evaluateAll((rows) => rows.map((r) => r.getAttribute("data-row-id")));
  expect(finishedIds.slice(0, 3)).toEqual([stale.id, create.id, update.id]);

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

  const page = await journeys.open("/brain/recent");
  const recent = page.getByRole("region", { name: "Recent saves" });
  const row = (text: string | RegExp) => recent.locator(".recent-change").filter({ hasText: text });
  await expect(recent).toBeVisible();
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
  const revert = recent.locator(".recent-change").first();
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

/** Where each chip of a chip row sits: its row, and whether the row shows all of it. */
async function chipPlaces(row: Locator) {
  return row.locator("ul").evaluate((list) => {
    const bar = list.getBoundingClientRect();
    return [...list.querySelectorAll("a")].map((chip) => {
      const box = chip.getBoundingClientRect();
      return { name: chip.textContent, top: Math.round(box.top), height: box.height, shown: box.left >= bar.left - 0.5 && box.right <= bar.right + 0.5 };
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

test("narrow layout: the Brain's collections are one row of chips that scrolls sideways, with the chosen one in view", async () => {
  const page = await journeys.open("/brain");
  for (const viewport of [{ width: 390, height: 844 }, { width: 900, height: 800 }]) {
    const at = `at ${viewport.width}px`;
    await page.setViewportSize(viewport);
    await page.goto(`${stack.url}/brain?tab=person`);
    const row = page.getByRole("navigation", { name: "Collections" });
    await expect(row.getByRole("link", { name: "People" })).toHaveAttribute("aria-current", "true");
    const places = await chipPlaces(row);
    expect(new Set(places.map((p) => p.top)).size, `collection chips on one row ${at}`).toBe(1);
    const box = (await row.boundingBox())!;
    expect(box.x + box.width, `the chip row stays inside the window ${at}`).toBeLessThanOrEqual(viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), `no horizontal overflow ${at}`).toBeLessThanOrEqual(0);
    // Opened from a link, the chosen chip is in view, and stays in view when Inter arrives after the chips were laid out in the fallback font.
    const releaseFont = await holdInter(page);
    await page.goto(`${stack.url}/brain?tab=deliverables`, { waitUntil: "commit" });
    await expect(row.getByRole("link", { name: "Deliverables" })).toHaveAttribute("aria-current", "true");
    expect(await page.evaluate(() => document.fonts.check('14px "Inter"')), `the chips are laid out before Inter arrives ${at}`).toBe(false);
    releaseFont();
    await expect.poll(() => page.evaluate(() => document.fonts.check('14px "Inter"')), `Inter arrives ${at}`).toBe(true);
    await expect.poll(async () => (await chipPlaces(row)).find((p) => p.name === "Deliverables")!.shown, `Deliverables in view when opened ${at}`).toBe(true);
  }
});

test("narrow layout: a picked note opens in view, Recent saves never start a line with a dot, and research gets a whole row", async () => {
  const page = await journeys.open("/brain");

  // On a phone the note opens below the list, and picking one brings it into view.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${stack.url}/brain?tab=project`);
  await page.locator(".note-list-item", { hasText: "Atlas launch" }).click();
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
  await page.goto(`${stack.url}/brain/recent`);
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
  const hit = page.locator(".result-item", { hasText: "40k EUR" }).first();
  await expect(hit).toContainText("unverified");

  // Refreshing the data folder raises one inbox item for the overdue fact, and none for the other.
  await page.goto(`${stack.url}/connections`);
  await (await openConnection(page, "vault-data")).getByRole("button", { name: "Refresh now" }).click();
  await expect(page.getByText("Refresh started")).toBeVisible();
  await page.goto(`${stack.url}/`);
  // A fact to check is its own type in the Inbox: a dated page, the words "Fact to check", from the Brain.
  const fact = inboxRow(page, "Review date passed: “Budget” in Helix rollout");
  await expect(fact).toHaveAttribute("data-type", "fact-review");
  await expect(fact).toContainText("Fact to check");
  await expect(fact.locator(".inbox-source")).toContainText("Brain");
  await expect(inboxRow(page, /“Status” in Helix rollout/)).toHaveCount(0);
});

test("reconnect: a claude.ai connector that loses sign-in offers Reconnect, which restores it", async () => {
  const setServer = (status: string) =>
    fetch(`${stack.fixtureUrl}/__control/claude-server`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "claude.ai Slack", status }) });
  // Connect, Test and Reconnect each start the fake Claude Code CLI, which is slow while other suites load the Machine.
  const cliRun = { timeout: 30_000 };
  const page = await journeys.open("/connections");
  const slack = connection(page, "slack");
  // Not set up, Slack is a tile under Work sources that opens in place into its setup form.
  await expect(slack.locator(".connection-tile-meta")).toHaveText("Not set up");
  await openConnection(page, "slack");
  await slack.getByRole("button", { name: "Connect" }).click();
  // Connected, it is a row in Work sources, still open.
  await expect(page.locator('[data-group="work"] .connection-row[data-connection="slack"]')).toBeVisible(cliRun);
  await expect(slack.getByRole("button", { name: "Test" })).toBeVisible();

  // The connector is signed out in claude.ai: the row moves to Needs you, open, and offers Reconnect, not just Reconfigure.
  await setServer("needs-auth");
  await slack.getByRole("button", { name: "Test" }).click();
  const needsYou = page.locator('[data-group="needs_you"]');
  await expect(needsYou.locator('[data-connection="slack"] [data-connection-state="sign_in"]')).toHaveText("Sign-in needed", cliRun);
  const callout = slack.getByRole("status", { name: "Sign-in needed" });
  await expect(callout).toContainText("claude.ai → Settings → Connectors");
  // The masthead counts the sign-in beside Connections.
  const connectionsLink = page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: /^Connections/ });
  await expect(connectionsLink).toHaveAccessibleName("Connections, 1 sign-in needed");
  await expect(connectionsLink.locator(".count")).toHaveText("1");

  // Reconnecting before the sign-in is fixed says what is still wrong.
  await callout.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.getByText(/Still not signed in: Slack is not connected in claude.ai/)).toBeVisible(cliRun);
  await expect(needsYou.locator('[data-connection="slack"]')).toBeVisible();

  // Home names the sign-in in one amber banner with its impact and Reconnect.
  await page.goto(`${stack.url}/`);
  const area = page.locator('[data-connection-banner][data-state="sign_in"]');
  await expect(area).toContainText("Slack · Sign-in needed · Replies and mentions may be missing");
  const amber = await area.evaluate((el) => {
    const probe = document.body.appendChild(document.createElement("span"));
    probe.style.color = "var(--amber)";
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return getComputedStyle(el).color === expected;
  });
  expect(amber).toBe(true);
  await setServer("connected");
  await area.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.getByText("Reconnected")).toBeVisible(cliRun);
  await expect(area).toHaveCount(0);
  await expect(connectionsLink).toHaveAccessibleName("Connections");
  await page.goto(`${stack.url}/connections`);
  await expect(page.locator('[data-group="work"] [data-connection="slack"]')).toBeVisible(cliRun);
  await expect(needsYou).toHaveCount(0);
  await expect(slack.locator('[data-connection-state="sign_in"]')).toHaveCount(0);
});

/** Select Check now and wait until the check has finished: the button reads "Checking…" meanwhile. */
async function checkNow(card: Locator) {
  await card.getByRole("button", { name: "Check now" }).click();
  await expect(card.getByRole("button", { name: "Check now" })).toBeEnabled();
}

test("replication: set up in Settings, joined from another Machine's setup, watched, blocked with its cause, and switched off", async ({ browser }) => {
  const remote = createBareRemote();
  const page = await journeys.open("/settings/machines");
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
    await second.goto(`${other.url}/settings/machines`);
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
    // In Settings' section list the warning sits on the section it is about, in words.
    const machinesEntry = page.getByRole("navigation", { name: "Settings sections" }).getByRole("link", { name: /^Machines and Replication/ });
    await expect(machinesEntry).toHaveAccessibleName("Machines and Replication, Replication blocked");
    await expect(machinesEntry).toContainText("Replication blocked");
    // The cause leads the section, above this Machine's name, so the warning leads straight to it.
    const problem = page.locator('[data-settings-section="machines"] [data-replication-problem]');
    await expect(problem).toContainText("Replication is blocked");
    const ourMachine = page.locator(".card", { has: page.getByRole("heading", { name: "This Machine" }) });
    expect((await problem.boundingBox())!.y).toBeLessThan((await ourMachine.boundingBox())!.y);
    await expect(problem).toContainText("plan.txt");
    await expect(problem).toContainText("What to do:");
    writeFileSync(join(stack.dataDir, "plan.txt"), "from the Work Mac\n");
    await checkNow(card);
    await expect(card.getByText("up to date", { exact: true })).toBeVisible();
    await expect(problem).toHaveCount(0);
    await expect(settingsLink).toHaveAccessibleName("Settings");
    await expect(machinesEntry).toHaveAccessibleName("Machines and Replication");

    // Both Machines name the Reader, here the Machine that set Replication up, and when it last refreshed every source.
    await expect(card.locator('[data-machine="Home PC"]').getByText("Reader", { exact: true })).toBeVisible();
    await second.goto(`${other.url}/connections`);
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
  await page.goto(`${stack.url}/connections`);
  await expect(page.locator(".page .reader-line")).toHaveAttribute("data-reader", "alone");
  await expect(page.locator(".page .reader-line")).toContainText("This Machine runs Source refresh and briefings.");
});

test("wording: no view says sync for reading sources; a source offers Refresh now", async () => {
  const page = await journeys.open("/connections");
  const gh = await openConnection(page, "github");
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
  const jira = await openConnection(page, "jira");
  await expect(jira.locator("label", { hasText: "Connector name in Claude Code" }).locator("code")).toHaveText("claude mcp list");
  await jira.getByRole("combobox", { name: "How to connect" }).selectOption("api-token");
  const link = jira.locator("label", { hasText: /^API token/ }).getByRole("link");
  await expect(link).toHaveAttribute("href", /^https:\/\/id\.atlassian\.com\/manage-profile\/security\/api-tokens\?/);
  await expect(link).toHaveText("Create a token");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(jira).not.toContainText("`");
});

test("wording: on Linux and Windows no view names macOS, and example folders are on this computer", async () => {
  const page = await journeys.open("/settings/schedules");
  await expect(page.getByRole("checkbox", { name: "Desktop notification for new urgent items" })).toBeVisible();
  // Every Settings section, each on its own page.
  for (const id of ["features", "schedules", "identity", "saving", "meaning-search", "backup", "machines", "clients", "service"]) {
    await page.goto(`${stack.url}/settings/${id}`);
    await expect(page.locator(`[data-settings-section="${id}"]`)).toBeVisible();
    if (id === "machines") {
      await page.getByRole("tab", { name: "Join another Machine" }).click();
      await expect(page.getByRole("textbox", { name: /Empty folder for the Brain/ })).toHaveAttribute("placeholder", join(DOCUMENTS, "Brain"));
    }
    await expectNoMacWording(page, `/settings/${id}`);
  }
  await page.goto(`${stack.url}/connections`);
  await page.getByRole("button", { name: /^Import a folder/ }).click();
  await expect(page.getByRole("textbox", { name: "Folder path" })).toHaveAttribute("placeholder", join(DOCUMENTS, "Notes"));
  await expectNoMacWording(page, "/connections");
});

test("no unresolved console errors across journeys", () => {
  expect(journeys.consoleErrors).toEqual([]);
});
