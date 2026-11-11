import { test, expect, type Page, type ConsoleMessage, type BrowserContext } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAll, startStack, type Stack } from "./stack.ts";

let stack: Stack;
let shared: BrowserContext;
const consoleErrors: string[] = [];

function watch(page: Page) {
  page.on("console", (m: ConsoleMessage) => {
    // Expected network failures while the service is deliberately stopped are not app errors.
    if (m.type() === "error" && !/ERR_CONNECTION_REFUSED|Failed to load resource|net::ERR/.test(m.text())) consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  buildAll();
  stack = await startStack();
  // One paired browser profile for all journeys, like a real user's browser.
  shared = await browser.newContext({ viewport: { width: 1360, height: 900 } });
});
test.afterAll(async () => {
  await shared?.close();
  await stack?.stop();
});

async function open(path = "/"): Promise<Page> {
  for (const p of shared.pages()) await p.close();
  const page = await shared.newPage();
  watch(page);
  await page.goto(`${stack.url}${path}`);
  await page.bringToFront();
  return page;
}

test("onboarding: pair, choose folder, preview import, features, connections, model, finish", async () => {
  const page = await shared.newPage();
  watch(page);
  await page.goto(stack.pairUrl());
  await expect(page.getByRole("heading", { name: "Where should Jarvis keep your knowledge?" })).toBeVisible();
  const folder = page.getByRole("textbox", { name: /Data folder/ });
  await folder.fill(stack.dataDir);
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByText(`New folder: ${stack.dataDir}`)).toBeVisible();
  await expect(page.getByText("Will modify: nothing")).toBeVisible();
  await page.getByRole("textbox", { name: "Folder to import" }).fill(stack.vaultDir);
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(page.getByText(/Will read 2 Markdown file/)).toBeVisible();
  await expect(page.getByText("Files changed in that folder: 0")).toBeVisible();
  await page.getByRole("textbox", { name: "Name" }).fill("Test User");
  await page.getByRole("textbox", { name: "Email" }).fill("alex@example.com");
  await page.getByRole("button", { name: "Use this folder" }).click();

  await expect(page.getByRole("heading", { name: "Choose what Jarvis does" })).toBeVisible();
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
  // Coding agents: connecting Claude Code adds Jarvis's hooks and keeps the user's own.
  const claude = page.locator('[data-connection="claude-code"]');
  await claude.getByRole("button", { name: "Set up" }).click();
  await expect(claude.getByText(/Adds three hooks to ~\/.claude\/settings.json/)).toBeVisible();
  await claude.getByRole("button", { name: "Connect" }).click();
  await expect(claude.getByText("connected", { exact: true })).toBeVisible();
  const claudeSettings = JSON.parse(readFileSync(join(stack.agentHome, ".claude/settings.json"), "utf8"));
  expect(claudeSettings.hooks.PreToolUse[0].hooks[0].command).toBe("rtk hook claude");
  for (const e of ["SessionStart", "PreCompact", "SessionEnd"]) expect(JSON.stringify(claudeSettings.hooks[e])).toContain("jarvis-agent-hook");
  // An agent that is not installed says so instead of writing anything.
  const codex = page.locator('[data-connection="codex"]');
  await codex.getByRole("button", { name: "Set up" }).click();
  await codex.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText(/Codex was not found on this Mac/)).toBeVisible();
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

test("chat: streaming grounded answer, citation opens the exact evidence lines, keyboard", async () => {
  const page = await open("/");
  await expect(page.getByText("Needs your attention")).toBeVisible();
  await page.keyboard.press("/");
  await expect(page.locator("#composer")).toBeFocused();
  await page.keyboard.type("When is the cutover plan due for the Orion migration?");
  await page.keyboard.press("Enter");
  const answer = page.locator(".msg.assistant").last();
  await expect(answer).toHaveAttribute("data-status", "complete");
  await expect(answer).toContainText("Send the cutover plan to finance");
  const chip = answer.locator(".source-chip").first();
  await expect(chip).toContainText("Orion");
  await answer.locator("button.cite").first().click();
  const drawer = page.getByRole("dialog", { name: /Evidence/ });
  await expect(drawer).toBeVisible();
  const hl = drawer.locator(".line.hl");
  await expect(hl.first()).toBeVisible();
  expect(await hl.allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining("Send the cutover plan to finance")]));
  await expect(drawer.getByText(`${stack.vaultDir}/Projects/Orion.md`)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  // Persistent conversation: reload keeps history.
  await page.reload();
  await expect(page.locator(".msg.user").last()).toContainText("cutover plan");
});

test("attention: dismiss persists across reload and briefings; briefing reports coverage", async () => {
  const page = await open("/");
  const item = page.locator("article.item", { hasText: "Review rollback runbook" });
  await item.getByRole("button", { name: "Dismiss" }).click();
  await expect(item).toBeHidden();
  await page.getByRole("button", { name: "Prepare briefing" }).click();
  await expect(page.locator(".briefing-lines li").first()).toBeVisible({ timeout: 30_000 });
  await page.getByRole("group", { name: "Briefing at a glance" }).getByRole("button", { name: /Review queue/ }).click();
  await expect(page.getByRole("region", { name: "Review queue" })).toBeInViewport();
  await page.reload();
  await expect(page.getByText(/Review acme\/web#42/)).toBeVisible();
  await expect(page.locator("article.item", { hasText: "Review rollback runbook" })).toHaveCount(0);
  await page.getByRole("button", { name: "Show dismissed" }).click();
  await expect(page.locator("article.item", { hasText: "Review rollback runbook" })).toBeVisible();
  await page.getByRole("button", { name: "Show open" }).click();
  await expect(page.locator(".coverage")).toContainText("GitHub");
});

test("home: drag the divider to resize the conversation; size persists; keyboard and reset", async () => {
  const page = await open("/");
  const chat = page.locator(".home .chat-col");
  const inbox = page.locator(".home .inbox-col");
  const divider = page.getByRole("separator", { name: "Resize conversation" });
  const width = async (l: typeof chat) => Math.round((await l.boundingBox())!.width);
  // The briefing column is the wide one by default.
  expect(await width(chat)).toBe(440);
  expect(await width(inbox)).toBeGreaterThan(440);

  const box = (await divider.boundingBox())!;
  const grab = { x: box.x + box.width / 2, y: box.y + 300 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x - 160, grab.y, { steps: 8 });
  await page.mouse.up();
  expect(await width(chat)).toBe(600);
  await page.reload();
  expect(await width(chat)).toBe(600);

  // It never squeezes either pane below its minimum.
  await divider.focus();
  await page.keyboard.press("End");
  expect(await width(chat)).toBe(320);
  await page.keyboard.press("ArrowLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", "344");
  await page.keyboard.press("Home");
  expect(await width(inbox)).toBe(360);

  await divider.dblclick();
  expect(await width(chat)).toBe(440);
});

test("drafts: prepare, edit, approve, blocked until write is authorised, then verified receipt", async () => {
  const page = await open("/");
  const pr = page.locator("article.item", { hasText: "Review acme/web#42" });
  await pr.getByRole("button", { name: "Prepare draft" }).click();
  await expect(pr.getByRole("button", { name: "View draft" })).toBeVisible({ timeout: 30_000 });
  await pr.getByRole("button", { name: "View draft" }).click();
  await expect(page.getByRole("heading", { name: "Drafts and approvals" })).toBeVisible();
  const box = page.getByRole("textbox", { name: "Text" });
  await expect(box).toHaveValue(/reviewed the changes/);
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
  await page.goto(`${stack.url}/drafts`);
  await page.getByRole("button", { name: "Send" }).click();
  const receipt = page.locator("[data-receipt]");
  await expect(receipt).toContainText("Verified", { timeout: 20_000 });
  await expect(page.locator("[data-action-id]")).toHaveAttribute("data-status", "succeeded");
});

test("jobs: work continues after the tab closes; cancellation reports what happened", async () => {
  const page = await open("/jobs");
  await page.getByRole("textbox", { name: "Research question" }).fill("What is the state of the Orion migration?");
  await page.getByRole("button", { name: "Research" }).click();
  await expect(page.locator("[data-job-id]")).toBeVisible();
  const jobUrl = page.url();
  await page.close();
  const page2 = await shared.newPage();
  watch(page2);
  await page2.goto(jobUrl);
  await expect(page2.locator("[data-job-id]")).toHaveAttribute("data-status", "succeeded", { timeout: 30_000 });
  await expect(page2.getByRole("button", { name: /Open deliverables\/research/ })).toBeVisible();
  await page2.getByRole("button", { name: "Diagnostics" }).click();
  await expect(page2.locator("[data-job-id]")).toHaveAttribute("data-status", "running");
  await page2.getByRole("button", { name: "Cancel" }).click();
  await expect(page2.locator("[data-job-id]")).toHaveAttribute("data-status", "cancelled");
  await expect(page2.getByText("Cancelled: the work stopped before finishing.").first()).toBeVisible();
});

test("feature switches: turning attention off changes the product and the backend", async () => {
  const page = await open("/settings");
  await page.getByRole("checkbox", { name: /^Attention and briefings/ }).click();
  await expect(page.getByRole("alert")).toContainText("Drafts and approvals needs Attention and briefings");
  await page.getByRole("button", { name: "Also turn off what depends on it" }).click();
  await expect(page.getByRole("checkbox", { name: /^Attention and briefings/ })).not.toBeChecked();
  await expect(page.getByRole("checkbox", { name: /^Drafts and approvals/ })).not.toBeChecked();
  await expect(page.getByText("attention:sync: off")).toBeVisible();
  await page.goto(stack.url);
  await expect(page.getByText("Attention and briefings is off")).toBeVisible();
  await page.goto(`${stack.url}/settings`);
  await page.getByRole("checkbox", { name: /^Drafts and approvals/ }).click();
  await page.getByRole("button", { name: "Turn on what it needs too" }).click();
  await expect(page.getByRole("checkbox", { name: /^Attention and briefings/ })).toBeChecked();
  await expect(page.getByText(/attention:sync: next/)).toBeVisible();
});

test("reconnection: service restart shows a banner, then recovers state", async () => {
  const page = await open("/");
  await expect(page.getByText("Needs your attention")).toBeVisible();
  await stack.stopService();
  await expect(page.getByText(/Reconnecting to the Jarvis service|Disconnected from the Jarvis service/)).toBeVisible({ timeout: 20_000 });
  await stack.startService();
  await expect(page.getByText(/Reconnecting to the Jarvis service|Disconnected from the Jarvis service/)).toBeHidden({ timeout: 30_000 });
  await page.getByRole("textbox", { name: "Message Jarvis" }).fill("Who is Priya Shah?");
  await page.keyboard.press("Enter");
  await expect(page.locator(".msg.assistant").last()).toHaveAttribute("data-status", "complete");
});

test("narrow screen: bottom navigation, no horizontal overflow, all views reachable", async () => {
  const page = await open("/");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/", "/memory", "/drafts", "/jobs", "/connections", "/settings"]) {
    await page.goto(`${stack.url}${path}`);
    await expect(page.locator(".bottom-nav")).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
  }
  await page.goto(stack.url);
  await expect(page.getByText("Needs your attention")).toBeVisible();
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message Jarvis" })).toBeVisible();
  await expect(page.getByText("Needs your attention")).toBeHidden();
  const navFits = await page.locator(".bottom-nav").evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(navFits, "bottom navigation fits without scrolling").toBe(true);
  await page.locator(".bottom-nav").getByRole("link", { name: "Memory" }).click();
  await expect(page.getByRole("heading", { name: "Memory" })).toBeVisible();
});

test("memory: capture a decision, correct it, and the next answer changes", async () => {
  const page = await open("/memory");
  await page.getByRole("button", { name: "Capture" }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Vendor sync");
  await page.getByRole("textbox", { name: "Note or source text" }).fill("We agreed to keep Nimbus as the email vendor for 2027.");
  await page.getByRole("checkbox", { name: /This contains a decision/ }).check();
  await page.getByRole("textbox", { name: "Decision", exact: true }).fill("Keep Nimbus as email vendor for 2027");
  await page.getByRole("button", { name: "Save capture" }).click();
  const state = page.locator('[data-subject="Decision"]');
  await expect(state).toContainText("Keep Nimbus as email vendor for 2027");
  await state.getByRole("button", { name: "Correct" }).click();
  await page.getByRole("textbox", { name: /New value for/ }).fill("Switch to Postmark for 2027");
  await page.getByRole("textbox", { name: "Why is it changing?" }).fill("Procurement chose Postmark");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(state).toContainText("Switch to Postmark for 2027");
  await expect(page.getByText(/was "Keep Nimbus as email vendor for 2027"/)).toBeVisible();
  await page.goto(stack.url);
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.getByRole("textbox", { name: "Message Jarvis" }).fill("Which email vendor did we decide on for 2027?");
  await page.keyboard.press("Enter");
  const answer = page.locator(".msg.assistant").last();
  await expect(answer).toHaveAttribute("data-status", "complete");
  await expect(answer).toContainText("Postmark");
  const file = readFileSync(join(stack.dataDir, "memory/decisions/vendor-sync.md"), "utf8");
  expect(file.split("## History")[1]).toContain("Keep Nimbus");
});

test("memory: a Proposal shows every part of the change and is applied or rejected in one click", async () => {
  const page = await open("/memory");
  // Proposals arrive from outside the Dashboard; post them with the browser's own session.
  const propose = (body: unknown) =>
    page.evaluate(async (b) => {
      const res = await fetch("/api/v1/memory/proposals", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-jarvis-client": "1" }, body: JSON.stringify(b) });
      if (!res.ok) throw new Error(`propose failed: ${res.status} ${await res.text()}`);
      return (await res.json()) as { id: string };
    }, body);
  const update = await propose({
    item: {
      action: "update",
      path: "memory/decisions/vendor-sync.md",
      facts: [
        { subject: "Decision", value: "Use Postmark from January 2027", reason: "Contract signed" },
        { subject: "Owner", value: "Procurement", reason: "Named in the contract" },
      ],
      events: ["Postmark contract signed"],
    },
    reason: "Vendor review session",
    source: { kind: "agent-session", ref: "claude-code/sess-e2e", label: "Claude Code session in jarvis" },
  });
  const create = await propose({ item: { action: "create", type: "person", title: "Lena Berg", facts: [{ subject: "Role", value: "Postmark account manager" }], tags: ["vendor"] }, reason: "Introduced in the vendor call" });

  const review = page.getByRole("region", { name: /Memory changes to review/ });
  const card = review.locator(`[data-proposal="${update.id}"]`);
  await expect(card.getByText("Update memory/decisions/vendor-sync.md")).toBeVisible();
  await expect(card.locator('[data-part="fact"]')).toHaveText([/Decision: Use Postmark from January 2027 \(Contract signed\)/, /Owner: Procurement \(Named in the contract\)/]);
  await expect(card.locator('[data-part="event"]')).toHaveText([/Postmark contract signed/]);
  await expect(card).toContainText("Why: Vendor review session");
  await expect(card).toContainText("Source: Claude Code session in jarvis");
  const newNote = review.locator(`[data-proposal="${create.id}"]`);
  await expect(newNote.getByText("New person: Lena Berg")).toBeVisible();
  await expect(newNote.locator('[data-part="tags"]')).toContainText("vendor");

  await card.getByRole("button", { name: "Apply" }).click();
  await expect(card).toHaveCount(0);
  await newNote.getByRole("button", { name: "Reject" }).click();
  await expect(review).toHaveCount(0);

  const file = readFileSync(join(stack.dataDir, "memory/decisions/vendor-sync.md"), "utf8");
  const [current, history] = file.split("## History");
  expect(current).toContain("Use Postmark from January 2027");
  expect(current).toContain("**Owner**");
  expect(history).toContain('**Decision** was "Switch to Postmark for 2027"');
  expect(history).toContain("Postmark contract signed");
  expect(existsSync(join(stack.dataDir, "memory/people/lena-berg.md"))).toBe(false);
  await page.goto(`${stack.url}/memory?path=${encodeURIComponent("memory/decisions/vendor-sync.md")}&tab=decision`);
  await expect(page.locator('[data-subject="Decision"]')).toContainText("Use Postmark from January 2027");
});

test("reconnect: a claude.ai connector that loses sign-in offers Reconnect, which restores it", async () => {
  const setServer = (status: string) =>
    fetch(`${stack.fixtureUrl}/__control/claude-server`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "claude.ai Slack", status }) });
  const page = await open("/connections");
  const slack = page.locator('[data-connection="slack"]');
  // On the full Connections page an unconfigured card opens straight into its setup form.
  await expect(slack.getByText("not connected", { exact: true })).toBeVisible();
  await slack.getByRole("button", { name: "Connect" }).click();
  await expect(slack.getByText("connected", { exact: true })).toBeVisible();

  // The connector is signed out in claude.ai: the card says so and offers Reconnect, not just Reconfigure.
  await setServer("needs-auth");
  await slack.getByRole("button", { name: "Test" }).click();
  await expect(slack.getByText("needs auth", { exact: true })).toBeVisible();
  const callout = slack.getByRole("status", { name: "Sign-in needed" });
  await expect(callout).toContainText("claude.ai → Settings → Connectors");

  // Reconnecting before the sign-in is fixed says what is still wrong.
  await callout.getByRole("button", { name: "Reconnect" }).click();
  await expect(page.getByText(/Still not signed in: Slack is not connected in claude.ai/)).toBeVisible();
  await expect(slack.getByText("needs auth", { exact: true })).toBeVisible();

  await setServer("connected");
  await callout.getByRole("button", { name: "Reconnect" }).click();
  await expect(slack.getByText("connected", { exact: true })).toBeVisible();
  await expect(slack.getByRole("status", { name: "Sign-in needed" })).toHaveCount(0);
  await expect(page.getByText("Reconnected")).toBeVisible();
});

test("no unresolved console errors across journeys", () => {
  expect(consoleErrors).toEqual([]);
});
