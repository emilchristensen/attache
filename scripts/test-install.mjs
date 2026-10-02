#!/usr/bin/env node
/**
 * Installation, upgrade, backup/restore and uninstall checks (A02, A14) against
 * the built release artifacts, in a clean temporary profile (fresh HOME, a
 * minimal PATH with no developer tools, its own LaunchAgent label and port).
 * Writes test-results/install-results.json. Usage:
 *   node scripts/test-install.mjs [--from 0.1.0 --to 0.1.1]
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const FROM = arg("from", "0.1.0");
const TO = arg("to", "0.1.1");
const PORT = Number(arg("port", "7690"));
const INSTANCE = `installtest${process.pid}`;
const HOME = mkdtempSync(join(tmpdir(), "jarvis-clean-home-"));
const PREFIX = join(HOME, "Library/Application Support/Jarvis");
const STATE = join(PREFIX, "state");
const DATA = join(HOME, "Documents/Jarvis");
const results = [];
const check = (id, name, ok, detail = "") => {
  results.push({ id, name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};
const artifact = (v) => join(ROOT, "release", v, `Jarvis-Installer-${v}-macos-arm64.command`);
const cleanEnv = { HOME, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", JARVIS_PORT: String(PORT), JARVIS_INSTANCE: INSTANCE, JARVIS_NO_OPEN: "1", TMPDIR: tmpdir(), USER: process.env.USER ?? "" };
const sh = (file, args = [], env = cleanEnv) => execFileSync("/bin/sh", [file, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const jarvisCli = (args, extraEnv = {}) => execFileSync(join(HOME, ".local/bin/jarvis"), args, { env: { ...cleanEnv, ...extraEnv }, encoding: "utf8" });
const label = `dev.jarvis.${INSTANCE}`;
// The user's own Claude Code settings, with a hook of their own, from before Jarvis existed.
const CLAUDE_SETTINGS = join(HOME, ".claude/settings.json");
const CLAUDE_BEFORE = JSON.stringify({ model: "opus", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }] } }, null, 2);
const agentLoaded = () => {
  try {
    execFileSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

async function http(method, path, body, token) {
  const send = () => fetch(`http://127.0.0.1:${PORT}/api/v1${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", "x-jarvis-client": "1" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  let r;
  try {
    r = await send();
  } catch (e) {
    // This test restarts the service on purpose; fetch may reuse a pooled keep-alive socket to the old
    // process, and non-idempotent requests are not retried for us. A fresh connection settles it.
    if (e?.cause?.code !== "ECONNRESET" && e?.cause?.code !== "UND_ERR_SOCKET") throw e;
    r = await send();
  }
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function pairToken() {
  const url = jarvisCli(["pair", "--json"]);
  const code = JSON.parse(url).code;
  return (await http("POST", "/pair", { code, kind: "cli", clientName: "install-test" })).body.token;
}

function brainFingerprint() {
  const git = (dir, args) => {
    try {
      return execFileSync("/usr/bin/git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
    } catch {
      return "n/a";
    }
  };
  const agents = (() => {
    try {
      return execFileSync("/bin/launchctl", ["list"], { encoding: "utf8" }).split("\n").filter((l) => /second-?brain/i.test(l)).map((l) => l.split("\t").pop()).sort().join(",");
    } catch {
      return "n/a";
    }
  })();
  const plistDir = join(homedir(), "Library/LaunchAgents");
  const plists = existsSync(plistDir) ? readdirSync(plistDir).filter((f) => /second-?brain|brain/i.test(f)).map((f) => `${f}:${createHash("sha256").update(readFileSync(join(plistDir, f))).digest("hex").slice(0, 12)}`).sort().join(",") : "";
  return {
    newBrain: `${git(join(homedir(), "old-notes"), ["rev-parse", "HEAD"])} ${createHash("sha256").update(git(join(homedir(), "old-notes"), ["status", "--porcelain"])).digest("hex").slice(0, 12)}`,
    oldBrain: `${git(join(homedir(), "OldNotes"), ["rev-parse", "HEAD"])} ${createHash("sha256").update(git(join(homedir(), "OldNotes"), ["status", "--porcelain"])).digest("hex").slice(0, 12)}`,
    agents,
    plists,
  };
}

/** Run the command Jarvis registered for a Claude Code hook event, as Claude Code does: a login shell, JSON on stdin. */
function runClaudeHook(event, input) {
  const s = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"));
  const cmd = s.hooks[event].flatMap((g) => g.hooks).find((h) => h.command.includes("jarvis-agent-hook")).command;
  return execFileSync("/bin/sh", ["-lc", cmd], { input: JSON.stringify(input), env: cleanEnv, encoding: "utf8" });
}

async function main() {
  for (const v of [FROM, TO]) if (!existsSync(artifact(v))) execFileSync(process.execPath, [join(ROOT, "scripts/build-release.mjs"), "--version", v], { stdio: "inherit" });
  const brainsBefore = brainFingerprint();
  console.log(`Clean profile HOME=${HOME} instance=${INSTANCE} port=${PORT}`);
  mkdirSync(join(HOME, ".claude"), { recursive: true });
  writeFileSync(CLAUDE_SETTINGS, CLAUDE_BEFORE);

  // --- A02: clean-profile install from the artifact, no developer tools on PATH ---
  const out1 = sh(artifact(FROM));
  const h1 = await http("GET", "/health");
  check("A02", "clean-profile install starts the service", h1.status === 200 && h1.body.version === FROM, `version ${h1.body?.version}`);
  const pairUrl = /Open: (http:\/\/127\.0\.0\.1:\d+\/pair#code=\w+)/.exec(out1)?.[1];
  check("A02", "installer prints a first-run pairing URL (opened automatically without JARVIS_NO_OPEN)", !!pairUrl, pairUrl ?? out1.slice(-300));
  // Open that URL in a real browser and confirm first-run setup appears.
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  await page.goto(pairUrl);
  const setupVisible = await page.getByRole("heading", { name: "Where should Jarvis keep your knowledge?" }).waitFor({ timeout: 15_000 }).then(() => true, () => false);
  check("A02", "the pairing URL opens first-run setup in the browser", setupVisible);
  await browser.close();
  check("A02", "service runs as a LaunchAgent under the user's session", agentLoaded(), label);
  check("A02", "bundled runtime used (no system Node needed)", readFileSync(join(HOME, "Library/LaunchAgents", `${label}.plist`), "utf8").includes(`${PREFIX}/current/runtime/node`));

  // The data folder already holds the user's own notes (e.g. an existing vault).
  mkdirSync(DATA, { recursive: true });
  writeFileSync(join(DATA, "README.md"), "# My own vault readme\n");
  writeFileSync(join(DATA, "Existing note.md"), "# Mine\n\nWritten before Jarvis.\n");
  // Configure a notes-only workspace with some data.
  let token = await pairToken();
  await http("POST", "/setup/data-folder", { path: DATA }, token);
  await http("PUT", "/features", { changes: { voice: true }, cascade: true }, token);
  await http("PATCH", "/config", { schedules: { syncEveryMinutes: 55 } }, token);
  await http("POST", "/memory/capture", { text: "The Helios budget review is on Thursday.", title: "Helios", source: { kind: "user", ref: "install-test" }, decision: { title: "Helios budget", decision: "Cap Helios at 40k" } }, token);
  await http("POST", "/setup/complete", {}, token);
  check("A02", "installing Jarvis does not touch coding-agent settings", readFileSync(CLAUDE_SETTINGS, "utf8") === CLAUDE_BEFORE);
  const claude = await http("POST", "/connections/claude-code/configure", { method: "hooks", fields: {} }, token);
  const hookCmds = JSON.stringify(JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8")).hooks);
  check("A02", "connecting Claude Code adds hooks that run through the installer's stable `current` path", claude.body?.test?.ok && hookCmds.includes(`${PREFIX}/current/runtime/node`) && hookCmds.includes(`${PREFIX}/current/service/jarvis-agent-hook.mjs`) && !hookCmds.includes(`/app/${FROM}/`), claude.body?.test?.message ?? JSON.stringify(claude.body));
  const cfgBefore = (await http("GET", "/config", null, token)).body.config;

  // --- A02: reinstall is idempotent ---
  sh(artifact(FROM));
  token = await pairToken();
  const cfgAfterReinstall = (await http("GET", "/config", null, token)).body.config;
  const appDirs = readdirSync(join(PREFIX, "app")).filter((d) => !d.startsWith("."));
  check("A02", "reinstall is idempotent (same config, one app version, healthy)", JSON.stringify(cfgAfterReinstall) === JSON.stringify(cfgBefore) && appDirs.join() === FROM && (await http("GET", "/health")).body.version === FROM, `apps=${appDirs.join(",")}`);
  const plists = readdirSync(join(HOME, "Library/LaunchAgents")).filter((f) => f.includes(INSTANCE));
  check("A02", "reinstall leaves exactly one LaunchAgent", plists.length === 1, plists.join(","));

  // --- A02/A14: upgrade preserves configuration and data ---
  sh(artifact(TO));
  const h2 = await http("GET", "/health");
  token = await pairToken();
  const cfgAfterUpgrade = (await http("GET", "/config", null, token)).body.config;
  const hits = (await http("GET", "/memory/search?q=Helios budget", null, token)).body.hits;
  const preUpgrade = readdirSync(join(STATE, "backups")).filter((f) => f.startsWith(`pre-upgrade-${FROM}-to-${TO}`));
  check("A02", "upgrade runs the new version", h2.body.version === TO, `version ${h2.body.version}`);
  check("A02", "upgrade preserves configuration", JSON.stringify(cfgAfterUpgrade) === JSON.stringify(cfgBefore));
  check("A02", "upgrade preserves data (decision still retrievable)", hits.some((h) => h.text.includes("Cap Helios at 40k")));
  check("A14", "upgrade takes a pre-upgrade backup first", preUpgrade.length === 1, preUpgrade[0] ?? "none");

  // --- A02: the hooks keep working across the upgrade and save a real session ---
  const hookTest = await http("POST", "/connections/claude-code/test", {}, token);
  check("A02", "Claude Code hooks are still current after the upgrade", hookTest.body?.test?.ok === true, hookTest.body?.test?.message);
  const transcript = join(HOME, "session.jsonl");
  writeFileSync(transcript, [{ type: "user", sessionId: "inst-1", cwd: HOME, timestamp: new Date().toISOString(), message: { role: "user", content: "Where do sessions go?" } }, { type: "assistant", sessionId: "inst-1", cwd: HOME, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "We decided they go to the data folder." }] } }].map((r) => JSON.stringify(r)).join("\n"));
  runClaudeHook("SessionEnd", { session_id: "inst-1", transcript_path: transcript, cwd: HOME, reason: "exit" });
  const saved = join(DATA, "evidence/sessions/transcripts/claude-code");
  let sessionSaved = false;
  for (let i = 0; i < 80 && !sessionSaved; i++) {
    await new Promise((r) => setTimeout(r, 250));
    sessionSaved = existsSync(saved) && readdirSync(saved).some((f) => f.includes("inst-1"));
  }
  check("A02", "a Claude Code session that ends is saved to the data folder by the installed hook", sessionSaved);

  // --- service control from the command line ---
  jarvisCli(["stop"]);
  const stopped = await http("GET", "/health").then(() => false, () => true);
  jarvisCli(["start"]);
  let started = false;
  for (let i = 0; i < 60 && !started; i++) {
    await new Promise((r) => setTimeout(r, 250));
    started = await http("GET", "/health").then((r) => r.status === 200, () => false);
  }
  check("A02", "jarvis stop / jarvis start control the service", stopped && started && agentLoaded());

  // --- A14: backup, then restore into a fresh profile ---
  const backup = JSON.parse(jarvisCli(["backup"]));
  check("A14", "backup archive created", existsSync(backup.path) && backup.bytes > 0 && backup.manifest.credentialsIncluded === false, backup.path);
  const freshState = mkdtempSync(join(tmpdir(), "jarvis-restored-state-"));
  const freshData = join(mkdtempSync(join(tmpdir(), "jarvis-restored-data-")), "Jarvis");
  const restored = JSON.parse(execFileSync(join(PREFIX, "current/bin/jarvis"), ["restore", backup.path, "--state-dir", freshState, "--data-folder", freshData], { env: { ...cleanEnv, JARVIS_STATE_DIR: freshState, JARVIS_CREDENTIAL_STORE: "file" }, encoding: "utf8" }));
  const restorePort = PORT + 1;
  const svc = spawn(join(PREFIX, "current/bin/jarvis"), ["serve", "--state-dir", freshState, "--port", String(restorePort)], { env: { ...cleanEnv, JARVIS_STATE_DIR: freshState, JARVIS_WEB_DIR: join(PREFIX, "current/web"), JARVIS_CREDENTIAL_STORE: "file", JARVIS_INSTANCE: `${INSTANCE}r` }, stdio: "ignore" });
  let restoredOk = false;
  try {
    for (let i = 0; i < 60 && !restoredOk; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        restoredOk = (await fetch(`http://127.0.0.1:${restorePort}/api/v1/health`)).ok;
      } catch {
        // starting
      }
    }
    const code = JSON.parse(execFileSync(join(PREFIX, "current/bin/jarvis"), ["pair", "--state-dir", freshState, "--json"], { env: { ...cleanEnv, JARVIS_PORT: String(restorePort) }, encoding: "utf8" })).code;
    const tok = (await (await fetch(`http://127.0.0.1:${restorePort}/api/v1/pair`, { method: "POST", headers: { "content-type": "application/json", "x-jarvis-client": "1" }, body: JSON.stringify({ code, kind: "cli" }) })).json()).token;
    const get = async (p) => (await fetch(`http://127.0.0.1:${restorePort}/api/v1${p}`, { headers: { authorization: `Bearer ${tok}` } })).json();
    const rcfg = (await get("/config")).config;
    const rhits = (await get("/memory/search?q=Helios budget")).hits;
    check("A14", "restore into a fresh profile brings back config and data", restoredOk && rcfg.setupCompleted && rcfg.schedules.syncEveryMinutes === 55 && rcfg.dataFolder === freshData && rhits.some((h) => h.text.includes("Cap Helios at 40k")), `dataFolder=${restored.dataFolder}`);
    const again = (() => {
      try {
        execFileSync(join(PREFIX, "current/bin/jarvis"), ["restore", backup.path, "--state-dir", freshState], { env: cleanEnv, stdio: "pipe" });
        return false;
      } catch {
        return true;
      }
    })();
    check("A14", "restore refuses to overwrite a live profile", again);
  } finally {
    svc.kill("SIGTERM");
  }

  // --- A14: uninstall keeps data; reinstall picks it up; delete-data removes everything ---
  sh(join(HOME, ".local/bin/jarvis-uninstall"));
  const healthGone = await http("GET", "/health").then(() => false, () => true);
  check("A14", "uninstall stops and removes the service", healthGone && !agentLoaded() && !existsSync(join(PREFIX, "app")));
  check("A14", "uninstall keeps user data and service state by default", existsSync(join(DATA, "memory/decisions")) && existsSync(join(STATE, "jarvis.sqlite")));
  check("A14", "uninstall removes exactly the hooks Jarvis added to Claude Code", JSON.stringify(JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"))) === JSON.stringify(JSON.parse(CLAUDE_BEFORE)));
  sh(artifact(TO));
  token = await pairToken();
  const cfgReinstalled = (await http("GET", "/config", null, token)).body.config;
  check("A14", "reinstall after uninstall continues with the kept data", cfgReinstalled.setupCompleted && cfgReinstalled.dataFolder === DATA);
  sh(join(HOME, ".local/bin/jarvis-uninstall"), ["--delete-data", "--yes"]);
  const remaining = existsSync(DATA) ? readdirSync(DATA).sort() : [];
  check("A14", "uninstall --delete-data removes service state and only what Jarvis created in the data folder", !existsSync(STATE) && !agentLoaded() && JSON.stringify(remaining) === JSON.stringify(["Existing note.md", "README.md"]) && readFileSync(join(DATA, "README.md"), "utf8").includes("My own vault readme"), `left: ${remaining.join(", ")}`);

  // --- Existing brains untouched ---
  const brainsAfter = brainFingerprint();
  check("A14", "the owner's own notes and schedules on this computer are unchanged", JSON.stringify(brainsBefore) === JSON.stringify(brainsAfter), JSON.stringify(brainsAfter));

  mkdirSync(join(ROOT, "test-results"), { recursive: true });
  writeFileSync(join(ROOT, "test-results/install-results.json"), JSON.stringify({ from: FROM, to: TO, home: HOME, at: new Date().toISOString(), results }, null, 2));
  rmSync(HOME, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} installation checks passed`);
}

main().catch(async (e) => {
  console.error(e);
  try {
    execFileSync("/bin/launchctl", ["bootout", `gui/${process.getuid()}/${label}`], { stdio: "ignore" });
  } catch {
    // not loaded
  }
  process.exit(1);
});
