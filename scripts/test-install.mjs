#!/usr/bin/env node
/**
 * Installation, upgrade, backup/restore and uninstall checks against
 * release artifacts built for this computer (macOS on Apple silicon, Linux or
 * Windows on x86_64), in a clean temporary profile (fresh home folder whose
 * name has a space and the letters æøå, a minimal PATH with no developer
 * tools, its own service name and port).
 * Writes test-results/install-results.json, and when a check fails, the installed
 * service's logs to test-results/install-logs. Usage:
 *   node scripts/test-install.mjs [--from 0.1.0 --to 0.1.1] [--port 7690]
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { installTestPlatform } from "./install-test/platform.mjs";
import { copyLogFolder } from "./service-logs.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const arg = (n, d) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const FROM = arg("from", "0.1.0");
const TO = arg("to", "0.1.1");
const PORT = Number(arg("port", "7690"));
const INSTANCE = `installtest${process.pid}`;
// The real path, as the installed service reports its own (no /var symlink on macOS, no 8.3 short names on Windows).
const HOME = realpathSync.native(mkdtempSync(join(tmpdir(), "attache clean home æøå-")));
const P = installTestPlatform(HOME, INSTANCE);
const PREFIX = P.prefix;
const STATE = P.state;
const DATA = join(HOME, "Documents", "Attache");
const NODE = P.runtime(PREFIX);
const SERVICE = join(PREFIX, "current", "service", "attache-service.mjs");
const INSTALL_LOGS = join(ROOT, "test-results", "install-logs");
const results = [];
const check = (id, name, ok, detail = "") => {
  results.push({ id, name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
};
const artifact = (v) => P.artifact(ROOT, v);
const cleanEnv = P.cleanEnv({ ATTACHE_PORT: String(PORT), ATTACHE_INSTANCE: INSTANCE, ATTACHE_NO_OPEN: "1", TMPDIR: tmpdir(), USER: process.env.USER ?? "" });
/**
 * Copy a service's logs (service.log, and service.err.log and service.out.log from the service manager)
 * to test-results/install-logs before the test removes its state folder.
 */
function keepLogs(stateDir, name) {
  try {
    copyLogFolder(join(stateDir, "logs"), join(INSTALL_LOGS, name));
  } catch (e) {
    console.warn(`could not keep the ${name} logs: ${e.message}`);
  }
}
/** Run an installer or command-line wrapper as the owner would from a terminal. */
const sh = (file, args = [], env = cleanEnv) => P.runScript(file, args, env);
const attacheCli = (args, extraEnv = {}) => P.runScript(P.command(P.binDir, "attache"), args, { ...cleanEnv, ...extraEnv });
/** The installed release's own runtime and service, without a wrapper in between. */
const installed = (args, env = cleanEnv) => execFileSync(NODE, [SERVICE, ...args], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The user's own Claude Code settings, with a hook of their own, from before Attache existed.
const CLAUDE_SETTINGS = join(HOME, ".claude/settings.json");
const CLAUDE_JSON = join(HOME, ".claude.json");
const CLAUDE_BEFORE = JSON.stringify({ model: "opus", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }] } }, null, 2);
// Other files the owner had before Attache: Claude Code's own state and a skill of their own, a tool next to where `attache` goes,
// a background service of their own, an existing vault.
const OWNER_FILES = {
  ".claude.json": JSON.stringify({ numStartups: 3, projects: {} }, null, 2),
  ".claude/skills/my-own-skill/SKILL.md": "---\nname: my-own-skill\n---\n",
  ".local/bin/owner-tool": "#!/bin/sh\necho mine\n",
  ...P.ownerFiles,
  [relative(HOME, join(DATA, "README.md"))]: "# My own vault readme\n",
  [relative(HOME, join(DATA, "Existing note.md"))]: "# Mine\n\nWritten before Attache.\n",
};

/**
 * A file's content, for comparing before and after. A Harness settings file
 * Attache edited and then restored only has to say the same thing, so JSON is
 * compared by meaning, not layout.
 */
function fingerprint(p) {
  if (!lstatSync(p).isFile()) return "link";
  const text = readFileSync(p, "utf8");
  const content = p.endsWith(".json") ? JSON.stringify(JSON.parse(text)) : text;
  return createHash("sha256").update(content).digest("hex");
}

// Windows PowerShell's own caches, which it writes on first use in a fresh profile whoever runs it: not Attache's files.
const POWERSHELL_CACHES = join(HOME, "AppData", "Local", "Microsoft", "Windows", "PowerShell");

/** Every file under the clean home folder, with a fingerprint of its content. */
function homeFiles(dir = HOME, out = new Map()) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (p === POWERSHELL_CACHES) continue;
    if (e.isDirectory()) homeFiles(p, out);
    else out.set(relative(HOME, p), fingerprint(p));
  }
  return out;
}

async function http(method, path, body, token) {
  const send = () => fetch(`http://127.0.0.1:${PORT}/api/v1${path}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", "x-attache-client": "1" }, ...(body ? { body: JSON.stringify(body) } : {}) });
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
  const url = attacheCli(["pair", "--json"]);
  const code = JSON.parse(url).code;
  return (await http("POST", "/pair", { code, kind: "cli", clientName: "install-test" })).body.token;
}
/** Wait until the service answers, and return what it says. */
async function waitForHealth(attempts = 120) {
  for (let i = 0; i < attempts; i++) {
    const h = await http("GET", "/health").catch(() => null);
    if (h?.status === 200) return h;
    await sleep(250);
  }
  return null;
}

/**
 * Start the MCP server a Harness configuration names, exactly as the Harness does (its command and
 * arguments, a clean environment plus the Harness's session variables), call `save`, and accept
 * the confirmation as the owner would. Returns the save's outcome.
 */
async function mcpSave(entry, items, sessionEnv) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const { ElicitRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const client = new Client({ name: "claude-code", version: "1.0.0" }, { capabilities: { elicitation: { form: {} } } });
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: {} }));
  await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...cleanEnv, ...sessionEnv }, cwd: HOME, stderr: "pipe" }));
  try {
    const r = await client.callTool({ name: "save", arguments: { items } });
    return r.isError ? r.content.map((c) => c.text).join(" ") : r.structuredContent.outcome;
  } finally {
    await client.close();
  }
}

/** Run the command Attache registered for a Claude Code hook event, as Claude Code does: through its shell, JSON on stdin. */
function runClaudeHook(event, input) {
  const s = JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"));
  const cmd = s.hooks[event].flatMap((g) => g.hooks).find((h) => h.command.includes("attache-agent-hook")).command;
  return P.runHook(cmd, JSON.stringify(input), cleanEnv);
}

async function main() {
  rmSync(INSTALL_LOGS, { recursive: true, force: true });
  // Always from the current source: a release left over from an earlier build would test old code.
  for (const v of [FROM, TO]) execFileSync(process.execPath, [join(ROOT, "scripts/build-release.mjs"), "--version", v, "--target", P.target], { stdio: "inherit" });
  const machineBefore = P.machineFingerprint();
  console.log(`Clean profile HOME=${HOME} service=${P.serviceName} port=${PORT}`);
  for (const [path, text] of Object.entries(OWNER_FILES)) {
    mkdirSync(dirname(join(HOME, path)), { recursive: true });
    writeFileSync(join(HOME, path), text);
  }
  mkdirSync(join(HOME, ".claude"), { recursive: true });
  writeFileSync(CLAUDE_SETTINGS, CLAUDE_BEFORE);
  const ownerHome = homeFiles();

  // --- clean-profile install from the artifact, no developer tools on PATH ---
  const out1 = sh(artifact(FROM));
  const h1 = await http("GET", "/health");
  check("install", "clean-profile install starts the service", h1.status === 200 && h1.body.version === FROM, `version ${h1.body?.version}`);
  const pairUrl = /Open: (http:\/\/127\.0\.0\.1:\d+\/pair#code=\w+)/.exec(out1)?.[1];
  check("install", "installer prints a first-run pairing URL (opened automatically without ATTACHE_NO_OPEN)", !!pairUrl, pairUrl ?? out1.slice(-300));
  // Open that URL in a real browser and confirm first-run setup appears.
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  await page.goto(pairUrl);
  const setupVisible = await page.getByRole("heading", { name: "Where should Attache keep your knowledge?" }).waitFor({ timeout: 15_000 }).then(() => true, () => false);
  check("install", "the pairing URL opens first-run setup in the browser", setupVisible);
  await browser.close();
  check("install", `service runs under the user's ${P.serviceKind}`, P.loaded(), P.serviceName);
  check("install", "service starts at login", P.startsAtLogin(), P.definition ?? P.serviceName);
  check("install", "bundled runtime used (no system Node needed)", P.runsBundledRuntime(PREFIX));

  // Configure a notes-only workspace with some data, in a data folder that already holds the owner's notes.
  let token = await pairToken();
  await http("POST", "/setup/data-folder", { path: DATA }, token);
  await http("PUT", "/features", { changes: { drafts: false }, cascade: true }, token);
  await http("PATCH", "/config", { schedules: { refreshEveryMinutes: 55 } }, token);
  await http("POST", "/memory/save", { confirmed: true, origin: { agent: "claude-code", sessionId: "install-test" }, items: [{ action: "create", type: "decision", title: "Helios budget", facts: [{ subject: "Decision", value: "Cap Helios at 40k" }] }] }, token);
  await http("POST", "/setup/complete", {}, token);
  check("install", "installing Attache does not touch any Harness settings", readFileSync(CLAUDE_SETTINGS, "utf8") === CLAUDE_BEFORE);
  const meaning = await http("GET", "/memory/meaning", undefined, token);
  check("install", "the release carries the meaning model's runtime, and the model waits for the owner to download it", existsSync(join(PREFIX, "current/service/ort-wasm-simd-threaded.wasm")) && meaning.body?.state === "missing", JSON.stringify(meaning.body));
  const claude = await http("POST", "/connections/claude-code/configure", { method: "hooks", fields: {} }, token);
  const hookCmds = JSON.stringify(JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8")).hooks);
  const inCommand = (...parts) => hookCmds.includes(P.commandPath(join(PREFIX, ...parts)));
  check("install", "connecting Claude Code adds hooks that run through the installer's stable `current` path", claude.body?.test?.ok && inCommand("current", "runtime", "node") && inCommand("current", "service", "attache-agent-hook.mjs") && !hookCmds.includes(`/app/${FROM}/`), claude.body?.test?.message ?? JSON.stringify(claude.body));
  const cfgBefore = (await http("GET", "/config", null, token)).body.config;

  // --- the service manager brings the service back after a crash ---
  const crashedPid = (await http("GET", "/status", null, token)).body.pid;
  process.kill(crashedPid, "SIGKILL");
  let restartedPid = null;
  for (let i = 0; i < 120 && !restartedPid; i++) {
    await sleep(250);
    const s = await http("GET", "/status", null, token).catch(() => null);
    if (s?.status === 200 && s.body.pid !== crashedPid) restartedPid = s.body.pid;
  }
  check("install", "the service is restarted after a crash", !!restartedPid, `pid ${crashedPid} -> ${restartedPid}`);

  // --- reinstall is idempotent ---
  sh(artifact(FROM));
  token = await pairToken();
  const cfgAfterReinstall = (await http("GET", "/config", null, token)).body.config;
  const appDirs = readdirSync(join(PREFIX, "app")).filter((d) => !d.startsWith("."));
  check("install", "reinstall is idempotent (same config, one app version, healthy)", JSON.stringify(cfgAfterReinstall) === JSON.stringify(cfgBefore) && appDirs.join() === FROM && (await http("GET", "/health")).body.version === FROM, `apps=${appDirs.join(",")}`);
  const definitions = P.definitions();
  check("install", "reinstall leaves exactly one service definition", definitions.length === 1, definitions.join(","));

  // --- upgrade preserves configuration and data ---
  // A speech model an earlier version downloaded for voice goes with the upgrade.
  const oldSpeechModel = join(STATE, "models", "ggml-base.en.bin");
  mkdirSync(dirname(oldSpeechModel), { recursive: true });
  writeFileSync(oldSpeechModel, "whisper model left by voice");
  // Save and audit skills an earlier version installed, next to the owner's own skill.
  const skillsDir = join(HOME, ".claude/skills");
  for (const name of ["attache-save", "attache-audit"]) {
    mkdirSync(join(skillsDir, name), { recursive: true });
    writeFileSync(join(skillsDir, name, "SKILL.md"), `---\nname: ${name}\n---\n`);
    writeFileSync(join(skillsDir, name, ".attache-skill.json"), JSON.stringify({ managedBy: "attache", stateDir: STATE, agents: ["claude-code"] }));
  }
  sh(artifact(TO));
  const h2 = await http("GET", "/health");
  token = await pairToken();
  const cfgAfterUpgrade = (await http("GET", "/config", null, token)).body.config;
  const hits = (await http("GET", "/memory/search?q=Helios budget", null, token)).body.hits;
  const preUpgrade = readdirSync(join(STATE, "backups")).filter((f) => f.startsWith(`pre-upgrade-${FROM}-to-${TO}`));
  check("install", "upgrade runs the new version", h2.body.version === TO, `version ${h2.body.version}`);
  check("install", "upgrade preserves configuration", JSON.stringify(cfgAfterUpgrade) === JSON.stringify(cfgBefore));
  check("install", "upgrade preserves data (decision still retrievable)", hits.some((h) => h.text.includes("Cap Helios at 40k")));
  check("data", "upgrade takes a pre-upgrade backup first", preUpgrade.length === 1, preUpgrade[0] ?? "none");
  check("install", "upgrade removes the speech model voice downloaded", !existsSync(oldSpeechModel));
  const skillsLeft = readdirSync(skillsDir).sort();
  check("install", "upgrade removes the save and audit skills Attache installed, and leaves other skills", JSON.stringify(skillsLeft) === JSON.stringify(["my-own-skill"]), skillsLeft.join(", "));

  // --- the hooks keep working across the upgrade and save a real session ---
  const hookTest = await http("POST", "/connections/claude-code/test", {}, token);
  check("install", "Claude Code hooks are still current after the upgrade", hookTest.body?.test?.ok === true, hookTest.body?.test?.message);
  const transcript = join(tmpdir(), `attache-install-session-${process.pid}.jsonl`);
  writeFileSync(transcript, [{ type: "user", sessionId: "inst-1", cwd: HOME, timestamp: new Date().toISOString(), message: { role: "user", content: "Where do sessions go?" } }, { type: "assistant", sessionId: "inst-1", cwd: HOME, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "text", text: "We decided they go to the data folder." }] } }].map((r) => JSON.stringify(r)).join("\n"));
  runClaudeHook("SessionEnd", { session_id: "inst-1", transcript_path: transcript, cwd: HOME, reason: "exit" });
  const saved = join(DATA, "evidence/sessions/transcripts/claude-code");
  let sessionSaved = false;
  for (let i = 0; i < 80 && !sessionSaved; i++) {
    await sleep(250);
    sessionSaved = existsSync(saved) && readdirSync(saved).some((f) => f.includes("inst-1"));
  }
  rmSync(transcript, { force: true });
  check("install", "a Claude Code session that ends is saved to the data folder by the installed hook", sessionSaved);

  // --- the MCP server Attache registered runs the installed CLI, with no attache on PATH, and saves what the owner confirms ---
  const mcpEntry = JSON.parse(readFileSync(CLAUDE_JSON, "utf8")).mcpServers?.attache;
  const viaCurrent = (p, expected) => p === expected && !/[\\/]app[\\/]/.test(p);
  check("install", "connecting Claude Code registers Attache's MCP server in ~/.claude.json through the stable `current` path", viaCurrent(mcpEntry?.command, NODE) && viaCurrent(mcpEntry.args[0], SERVICE) && mcpEntry.args.slice(1).join(" ") === `mcp --state-dir ${STATE}`, JSON.stringify(mcpEntry));
  const mcpItems = [{ action: "create", type: "decision", title: "The MCP server runs the installed CLI", facts: [{ subject: "Decision", value: "Harnesses start the bundled node and service, so the server needs nothing on PATH" }] }];
  let mcpOutcome = "";
  try {
    mcpOutcome = await mcpSave(mcpEntry, mcpItems, { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "inst-1" });
  } catch (e) {
    mcpOutcome = String(e.message);
  }
  const savedNote = join(DATA, "memory/decisions/the-mcp-server-runs-the-installed-cli.md");
  check("install", "a save through the registered MCP server, confirmed in the Harness, writes curated memory citing the session", mcpOutcome === "saved" && existsSync(savedNote) && readFileSync(savedNote, "utf8").includes("agent-session: evidence/sessions/transcripts/claude-code/"), mcpOutcome);
  const saveCmd = (() => {
    try {
      attacheCli(["save"]);
      return "ran";
    } catch (e) {
      return String(e.stderr ?? e.message);
    }
  })();
  check("install", "the command line has no save command", saveCmd.includes("Unknown command save"), saveCmd.trim());

  // --- service control from the command line ---
  attacheCli(["stop"]);
  const stopped = await http("GET", "/health").then(() => false, () => true);
  attacheCli(["start"]);
  const started = await waitForHealth(60);
  check("install", "attache stop / attache start control the service", stopped && !!started && P.loaded());

  // --- backup, then restore into a fresh profile ---
  const backup = JSON.parse(attacheCli(["backup"]));
  check("data", "backup archive created", existsSync(backup.path) && backup.bytes > 0 && backup.manifest.credentialsIncluded === false, backup.path);
  const freshState = mkdtempSync(join(tmpdir(), "attache-restored-state-"));
  const freshData = join(mkdtempSync(join(tmpdir(), "attache-restored-data-")), "Attache");
  const restored = JSON.parse(installed(["restore", backup.path, "--state-dir", freshState, "--data-folder", freshData], { ...cleanEnv, ATTACHE_STATE_DIR: freshState, ATTACHE_CREDENTIAL_STORE: "file" }));
  const restorePort = PORT + 1;
  const svc = spawn(NODE, [SERVICE, "serve", "--state-dir", freshState, "--port", String(restorePort)], { env: { ...cleanEnv, ATTACHE_STATE_DIR: freshState, ATTACHE_WEB_DIR: join(PREFIX, "current", "web"), ATTACHE_CREDENTIAL_STORE: "file", ATTACHE_INSTANCE: `${INSTANCE}r` }, stdio: "ignore" });
  let restoredOk = false;
  try {
    for (let i = 0; i < 120 && !restoredOk; i++) {
      await sleep(250);
      restoredOk = await fetch(`http://127.0.0.1:${restorePort}/api/v1/health`).then((r) => r.ok, () => false);
    }
    const code = JSON.parse(installed(["pair", "--state-dir", freshState, "--json"], { ...cleanEnv, ATTACHE_PORT: String(restorePort) })).code;
    const tok = (await (await fetch(`http://127.0.0.1:${restorePort}/api/v1/pair`, { method: "POST", headers: { "content-type": "application/json", "x-attache-client": "1" }, body: JSON.stringify({ code, kind: "cli" }) })).json()).token;
    const get = async (p) => (await fetch(`http://127.0.0.1:${restorePort}/api/v1${p}`, { headers: { authorization: `Bearer ${tok}` } })).json();
    const rcfg = (await get("/config")).config;
    const rhits = (await get("/memory/search?q=Helios budget")).hits;
    check("data", "restore into a fresh profile brings back config and data", restoredOk && rcfg.setupCompleted && rcfg.schedules.refreshEveryMinutes === 55 && rcfg.dataFolder === freshData && rhits.some((h) => h.text.includes("Cap Helios at 40k")), `dataFolder=${restored.dataFolder}`);
    const again = (() => {
      try {
        installed(["restore", backup.path, "--state-dir", freshState]);
        return false;
      } catch {
        return true;
      }
    })();
    check("data", "restore refuses to overwrite a live profile", again);
  } finally {
    const exited = new Promise((r) => svc.once("exit", r));
    // Killed outright, as Windows always ends it (it has no SIGTERM) and as a crash would: the writer lock
    // it leaves behind is one the data-deleting uninstall below must still remove.
    svc.kill("SIGKILL");
    await Promise.race([exited, sleep(10_000)]);
    keepLogs(freshState, "restored-state");
    for (const dir of [freshState, dirname(freshData)]) rmSync(dir, { recursive: true, force: true });
  }

  // --- uninstall keeps data; reinstall picks it up; delete-data removes everything ---
  sh(P.command(P.binDir, "attache-uninstall"));
  const healthGone = await http("GET", "/health").then(() => false, () => true);
  check("data", "uninstall stops and removes the service", healthGone && !P.loaded() && !P.known() && !existsSync(join(PREFIX, "app")));
  check("data", "uninstall keeps user data and service state by default", existsSync(join(DATA, "memory/decisions")) && existsSync(join(STATE, "attache.sqlite")));
  check("data", "uninstall removes exactly the hooks Attache added to Claude Code", JSON.stringify(JSON.parse(readFileSync(CLAUDE_SETTINGS, "utf8"))) === JSON.stringify(JSON.parse(CLAUDE_BEFORE)));
  const mcpAfterUninstall = JSON.parse(readFileSync(CLAUDE_JSON, "utf8")).mcpServers;
  check("data", "uninstall removes the MCP server Attache added to Claude Code", mcpAfterUninstall === undefined, JSON.stringify(mcpAfterUninstall));
  sh(artifact(TO));
  token = await pairToken();
  const cfgReinstalled = (await http("GET", "/config", null, token)).body.config;
  check("data", "reinstall after uninstall continues with the kept data", cfgReinstalled.setupCompleted && cfgReinstalled.dataFolder === DATA);
  // The data-deleting uninstall removes the state folder and the service's logs with it.
  keepLogs(STATE, "state");
  sh(P.command(P.binDir, "attache-uninstall"), ["--delete-data", "--yes"]);
  const remaining = existsSync(DATA) ? readdirSync(DATA).sort() : [];
  check("data", "uninstall --delete-data removes service state and only what Attache created in the data folder", !existsSync(STATE) && !P.loaded() && JSON.stringify(remaining) === JSON.stringify(["Existing note.md", "README.md"]), `left: ${remaining.join(", ")}`);
  const homeAfter = homeFiles();
  const changed = [...ownerHome].filter(([path, hash]) => homeAfter.get(path) !== hash).map(([path]) => path);
  const leftBehind = [...homeAfter.keys()].filter((path) => !ownerHome.has(path));
  check("data", "uninstall leaves every file the owner had before Attache as it was", changed.length === 0, changed.join(", "));
  check("data", "uninstall --delete-data leaves no Attache file in the home folder", leftBehind.length === 0 && !existsSync(PREFIX), leftBehind.join(", "));

  // --- The owner's own setup on this computer is untouched ---
  check("data", "the owner's own Attache services on this computer are unchanged", JSON.stringify(machineBefore) === JSON.stringify(P.machineFingerprint()), JSON.stringify(P.machineFingerprint()));

  mkdirSync(join(ROOT, "test-results"), { recursive: true });
  writeFileSync(join(ROOT, "test-results/install-results.json"), JSON.stringify({ target: P.target, from: FROM, to: TO, home: HOME, at: new Date().toISOString(), results }, null, 2));
  rmSync(HOME, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok).length;
  // The logs are kept for a failed run only.
  if (!failed) rmSync(INSTALL_LOGS, { recursive: true, force: true });
  console.log(`\n${results.length - failed}/${results.length} installation checks passed`);
}

main().catch((e) => {
  console.error(e);
  keepLogs(STATE, "state");
  P.cleanup();
  process.exit(1);
});
