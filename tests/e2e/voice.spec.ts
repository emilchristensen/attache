/**
 * Real voice: whisper.cpp transcribes audio captured by Chrome's (fake) microphone
 * device fed from a spoken WAV, and macOS `say` produces the spoken answer. The
 * model answering the question is the fixture model; the speech path is real.
 */
import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { buildAll, startStack, type Stack } from "./stack.ts";

const WHISPER = ["/opt/homebrew/bin/whisper-cli", "/usr/local/bin/whisper-cli"].find(existsSync);
const MODEL_CACHE = join(homedir(), ".cache/jarvis-test/ggml-base.en.bin");

let stack: Stack;
let token: string;
let browser: Browser;
let wav: string;

test.describe.configure({ mode: "serial" });
test.skip(!WHISPER || process.platform !== "darwin", "whisper.cpp or macOS speech is not available on this host (blocked validation, not a pass)");

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(`${stack.url}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-jarvis-client": "1" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return r.json();
}

async function pairedPage(b: Browser): Promise<Page> {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  await page.goto(stack.pairUrl());
  await expect(page.getByText("Needs your attention")).toBeVisible();
  return page;
}

test.beforeAll(async () => {
  test.setTimeout(600_000);
  buildAll();
  stack = await startStack({ port: 7612 });
  const code = new URL(stack.pairUrl()).hash.replace("#code=", "");
  token = (await (await fetch(`${stack.url}/api/v1/pair`, { method: "POST", headers: { "content-type": "application/json", "x-jarvis-client": "1" }, body: JSON.stringify({ code, kind: "cli", clientName: "voice-driver" }) })).json()).token;
  await api("POST", "/setup/data-folder", { path: stack.dataDir });
  await api("POST", "/import", { path: stack.vaultDir });
  await api("POST", "/connections/model/configure", { method: "openai-compatible", fields: { baseUrl: `${stack.fixtureUrl}/model`, model: "fixture" } });
  await api("PUT", "/features", { changes: { voice: true }, cascade: true });
  // The recognition model is downloaded by Jarvis itself; a local cache avoids re-downloading 148 MB per run.
  const modelsDir = join(stack.stateDir, "models");
  mkdirSync(modelsDir, { recursive: true });
  if (existsSync(MODEL_CACHE)) copyFileSync(MODEL_CACHE, join(modelsDir, "ggml-base.en.bin"));
  else {
    await api("POST", "/voice/model/download");
    for (let i = 0; i < 600; i++) {
      const st = await api("GET", "/voice/status");
      if (st.environment.whisperModel) break;
      if (st.environment.download.state === "failed") throw new Error(`model download failed: ${st.environment.download.error}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    mkdirSync(join(homedir(), ".cache/jarvis-test"), { recursive: true });
    copyFileSync(join(modelsDir, "ggml-base.en.bin"), MODEL_CACHE);
  }
  expect(statSync(join(modelsDir, "ggml-base.en.bin")).size).toBeGreaterThan(100_000_000);
  const speech = await api("POST", "/connections/speech/configure", { method: "local", fields: { stt: "whisper-local", tts: "macos-say" } });
  expect(speech.test.ok, speech.test.message).toBe(true);
  await api("POST", "/setup/complete");
  // A spoken question recorded to WAV, played into Chrome's fake microphone.
  const dir = mkdtempSync(join(tmpdir(), "jarvis-voice-"));
  wav = join(dir, "question.wav");
  execFileSync("/usr/bin/say", ["-o", join(dir, "q.aiff"), "[[slnc 1500]] What do my notes say about the rollback runbook? [[slnc 3500]]"]);
  execFileSync("/usr/bin/afconvert", ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", join(dir, "q.aiff"), wav]);
});

test.afterAll(async () => {
  await browser?.close().catch(() => {});
  await stack?.stop();
});

test("push-to-talk: real transcription, grounded answer, real spoken reply, interruption", async () => {
  browser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`, "--autoplay-policy=no-user-gesture-required"],
  });
  const page = await pairedPage(browser);
  await page.context().grantPermissions(["microphone"], { origin: stack.url });
  await page.getByLabel("Speak replies to voice questions").check();
  const talk = page.getByRole("button", { name: "Hold to talk" });
  await talk.hover();
  await page.mouse.down();
  await expect(page.locator(".chat-head .orb[data-state='listening']")).toBeVisible();
  await page.waitForTimeout(9000);
  await page.mouse.up();
  await expect(page.locator(".msg.user").last()).toContainText(/roll ?back run ?book/i, { timeout: 60_000 });
  const answer = page.locator(".msg.assistant").last();
  await expect(answer).toHaveAttribute("data-status", "complete", { timeout: 30_000 });
  await expect(answer).toContainText("rollback runbook");
  await expect(answer.locator(".source-chip").first()).toBeVisible();
  await expect(page.locator(".chat-head .orb[data-state='speaking']")).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press("Escape");
  await expect(page.locator(".chat-head .orb[data-state='idle']")).toBeVisible();
  await expect(page.getByText("Stopped speaking.")).toBeVisible();
  // Text is unaffected by the interruption.
  await expect(answer).toContainText("rollback runbook");
  await page.context().close();
});

test("text conversation stays usable while background work runs", async () => {
  const page = await pairedPage(browser);
  const job = (await api("POST", "/jobs", { kind: "demo-long", input: { steps: 40, stepMs: 500 } })).job;
  await page.getByRole("textbox", { name: "Message Jarvis" }).fill("Who is Priya Shah?");
  await page.keyboard.press("Enter");
  await expect(page.locator(".msg.assistant").last()).toHaveAttribute("data-status", "complete", { timeout: 20_000 });
  expect((await api("GET", `/jobs/${job.id}`)).job.status).toBe("running");
  await api("POST", `/jobs/${job.id}/cancel`);
  await page.context().close();
});

test("denied microphone shows recovery guidance and typing still works", async () => {
  const denied = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-device-for-media-stream", "--deny-permission-prompts"] });
  try {
    const page = await pairedPage(denied);
    await page.getByRole("button", { name: "Hold to talk" }).hover();
    await page.mouse.down();
    await page.mouse.up();
    await expect(page.getByRole("alert").filter({ hasText: "Microphone access is blocked" })).toBeVisible();
    await expect(page.locator(".chat-head .orb[data-state='error']")).toBeVisible();
    await expect(page.getByRole("button", { name: "Try the microphone again" })).toBeVisible();
    await page.getByRole("textbox", { name: "Message Jarvis" }).fill("Who is Priya Shah?");
    await page.keyboard.press("Enter");
    await expect(page.locator(".msg.assistant").last()).toHaveAttribute("data-status", "complete");
    await expect(page.locator(".msg.assistant").last()).toContainText("Priya");
  } finally {
    await denied.close();
  }
});

test("a press released before the microphone opens does not leave recording on", async () => {
  const b = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`] });
  try {
    const page = await pairedPage(b);
    const ptt = page.getByRole("button", { name: "Hold to talk" });
    // Release in the same task as the press: getUserMedia cannot have resolved yet.
    await ptt.evaluate((el) => {
      const opts = { bubbles: true, pointerId: 1, isPrimary: true };
      el.dispatchEvent(new PointerEvent("pointerdown", opts));
      el.dispatchEvent(new PointerEvent("pointerup", opts));
    });
    await expect(page.getByText("Hold the button (or Space) while you speak.")).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(ptt).toHaveAttribute("aria-pressed", "false");
  } finally {
    await b.close();
  }
});

test("unavailable speech service has a usable recovery state", async () => {
  // Point recognition at a speech endpoint that is offline.
  await api("POST", "/connections/speech/configure", { method: "openai-compatible", fields: { baseUrl: "http://127.0.0.1:9/v1" } });
  const b = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}`] });
  try {
    const page = await pairedPage(b);
    await page.getByRole("button", { name: "Hold to talk" }).hover();
    await page.mouse.down();
    await page.waitForTimeout(1500);
    await page.mouse.up();
    await expect(page.getByRole("alert").filter({ hasText: /Speech recognition failed: Speech service unreachable.*Typing still works/ })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("textbox", { name: "Message Jarvis" }).fill("Who is Priya Shah?");
    await page.keyboard.press("Enter");
    await expect(page.locator(".msg.assistant").last()).toHaveAttribute("data-status", "complete");
    const bad = await page.evaluate(async () => (await fetch("/api/v1/voice/transcribe", { method: "POST", headers: { "content-type": "audio/wav", "x-jarvis-client": "1" }, body: new Uint8Array([1, 2, 3]) })).status);
    expect(bad).toBe(400);
  } finally {
    await b.close();
    await api("POST", "/connections/speech/configure", { method: "local", fields: { stt: "whisper-local", tts: "macos-say" } });
  }
});
