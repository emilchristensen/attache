#!/usr/bin/env node
/**
 * `pnpm dev`: the service against a scratch profile, rebuilt and restarted on
 * every change, and the web client with hot reload in front of it.
 *
 *   pnpm dev [--port 7500] [--state-dir <folder>]
 *
 * The scratch profile keeps its state, secrets (in a file), writer locks and
 * Harness home inside the state folder, so nothing touches your own install
 * or your Harnesses' settings. Stop with Ctrl-C.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVICE_DIR = join(ROOT, "apps/service");
const BUNDLE = join(SERVICE_DIR, "dist/attache-service.mjs");
const WEB_PORT = 5173;
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
/** A burst of rebuilt files restarts the service once. */
const RESTART_AFTER_MS = 300;
const HEALTH_TIMEOUT_MS = 20_000;

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`);
  return value;
}

const port = Number(option("port", process.env.ATTACHE_PORT ?? "7500"));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`--port must be a TCP port number, not ${port}`);
const stateDir = resolve(option("state-dir", process.env.ATTACHE_STATE_DIR ?? join(tmpdir(), "attache-dev")));
const serviceUrl = `http://127.0.0.1:${port}`;

const env = {
  ...process.env,
  ATTACHE_STATE_DIR: stateDir,
  ATTACHE_PORT: String(port),
  ATTACHE_INSTANCE: process.env.ATTACHE_INSTANCE ?? "dev",
  ATTACHE_CREDENTIAL_STORE: "file",
  ATTACHE_AGENT_HOME: join(stateDir, "home"),
  ATTACHE_LOCK_DIR: join(stateDir, "locks"),
  ATTACHE_DEV_ORIGINS: WEB_ORIGIN,
};
mkdirSync(env.ATTACHE_AGENT_HOME, { recursive: true });

const children = new Set();
function start(command, args, opts = {}) {
  const child = spawn(command, args, { cwd: ROOT, env, stdio: "inherit", ...opts });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

function stopAll(code = 0) {
  for (const child of children) child.kill("SIGTERM");
  process.exit(code);
}
process.on("SIGINT", () => stopAll(0));
process.on("SIGTERM", () => stopAll(0));

async function healthy() {
  const end = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${serviceUrl}/api/v1/health`)).ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

const bundleHash = () => createHash("sha256").update(readFileSync(BUNDLE)).digest("hex");

let service = null;
let runningHash = null;
async function restartService() {
  // A failed rebuild leaves no bundle: keep the running service until the next build succeeds.
  if (!existsSync(BUNDLE)) {
    console.error("dev: the rebuild failed (see the error above), so the service keeps running the last good build.");
    return;
  }
  // The watcher's first build writes the same bundle again; only a changed one restarts the service.
  const hash = bundleHash();
  if (hash === runningHash) return;
  runningHash = hash;
  if (service) {
    const exited = new Promise((r) => service.once("exit", r));
    service.kill("SIGTERM");
    await exited;
  }
  service = start(process.execPath, ["--enable-source-maps", BUNDLE, "serve", "--state-dir", stateDir, "--port", String(port)]);
  if (!(await healthy())) console.error(`dev: the service did not answer on ${serviceUrl} within ${HEALTH_TIMEOUT_MS / 1000} seconds; see its output above.`);
}

function pairingLink() {
  const r = spawnSync(process.execPath, [BUNDLE, "pair", "--state-dir", stateDir, "--json"], { env, encoding: "utf8" });
  if (r.status !== 0) return null;
  const { code } = JSON.parse(r.stdout);
  return `${WEB_ORIGIN}/pair#code=${code}`;
}

// A full build first, so the bundle, the hook command and the web client all exist.
const built = spawnSync(process.execPath, [join(SERVICE_DIR, "build.mjs")], { cwd: ROOT, env, stdio: "inherit" });
if (built.status !== 0) process.exit(built.status ?? 1);
if (!existsSync(BUNDLE)) throw new Error(`The build did not write ${BUNDLE}`);

await restartService();
start(process.execPath, [join(SERVICE_DIR, "build.mjs"), "--watch"]);
let timer = null;
watch(dirname(BUNDLE), (_event, file) => {
  if (file !== "attache-service.mjs") return;
  clearTimeout(timer);
  timer = setTimeout(() => void restartService(), RESTART_AFTER_MS);
});
start("pnpm", ["--filter", "@attache/web", "exec", "vite", "--port", String(WEB_PORT), "--strictPort"], { env: { ...env, ATTACHE_DEV_SERVICE: serviceUrl }, shell: process.platform === "win32" });

const link = pairingLink();
console.log(`\nAttache dev: service ${serviceUrl}, state in ${stateDir}`);
console.log(`Open the hot-reload Dashboard and pair it: ${link ?? `${WEB_ORIGIN} (run \`node ${BUNDLE} pair --state-dir ${stateDir}\` for a code)`}\n`);
