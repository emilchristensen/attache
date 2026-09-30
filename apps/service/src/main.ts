import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { App, VERSION } from "./app.ts";
import { startServer } from "./http/server.ts";
import { createPairingCode } from "./http/security.ts";
import { resolvePaths } from "./core/paths.ts";
import { openDb } from "./core/db.ts";
import { createBackup, restoreBackup } from "./backup.ts";

export const DEFAULT_PORT = 7427;

interface Runtime {
  pid: number;
  port: number;
  url: string;
  version: string;
  startedAt: string;
  instance: string;
}

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function readRuntime(file: string): Runtime | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Runtime;
  } catch {
    return null;
  }
}

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const out = (s: string) => process.stdout.write(s + "\n");

async function serve(argv: string[]) {
  const stateDir = arg("state-dir", argv);
  const port = Number(arg("port", argv) ?? process.env.JARVIS_PORT ?? DEFAULT_PORT);
  const app = new App({ ...(stateDir ? { stateDir } : {}) });
  const handle = await startServer(app, { port });
  app.start();
  const runtime: Runtime = { pid: process.pid, port: handle.port, url: handle.url, version: VERSION, startedAt: app.startedAt, instance: app.instance };
  writeFileSync(app.paths.runtimeFile, JSON.stringify(runtime, null, 2), { mode: 0o600 });
  app.log.info("jarvis service listening", { url: handle.url, version: VERSION, stateDir: app.paths.stateDir });
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info("stopping", { signal });
    await handle.close();
    await app.stop();
    if (readRuntime(app.paths.runtimeFile)?.pid === process.pid) rmSync(app.paths.runtimeFile, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

async function pair(argv: string[]) {
  const paths = resolvePaths(arg("state-dir", argv));
  const db = openDb(paths.dbFile);
  const { code, expiresAt } = createPairingCode(db, "setup");
  db.close();
  const rt = readRuntime(paths.runtimeFile);
  const port = rt?.port ?? Number(process.env.JARVIS_PORT ?? DEFAULT_PORT);
  const url = `http://127.0.0.1:${port}/pair#code=${code}`;
  if (argv.includes("--json")) out(JSON.stringify({ code, url, expiresAt }));
  else out(`Pairing code: ${code} (expires ${expiresAt})\nOpen: ${url}`);
  if (argv.includes("--open")) execFile("/usr/bin/open", [url]);
}

async function status(argv: string[]) {
  const paths = resolvePaths(arg("state-dir", argv));
  const rt = readRuntime(paths.runtimeFile);
  if (!rt || !alive(rt.pid)) {
    out(JSON.stringify({ running: false, stateDir: paths.stateDir }));
    process.exitCode = 3;
    return;
  }
  try {
    const res = await fetch(`${rt.url}/api/v1/health`);
    out(JSON.stringify({ running: true, ...rt, health: await res.json() }));
  } catch (e) {
    out(JSON.stringify({ running: false, pid: rt.pid, error: (e as Error).message }));
    process.exitCode = 3;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "serve";
  switch (cmd) {
    case "serve":
      return serve(argv);
    case "pair":
      return pair(argv);
    case "status":
      return status(argv);
    case "version":
      return out(VERSION);
    case "stop":
    case "start": {
      // Controls the LaunchAgent the installer created (macOS).
      const instance = process.env.JARVIS_INSTANCE ?? "default";
      const label = instance === "default" ? "dev.jarvis.service" : `dev.jarvis.${instance}`;
      const plist = `${process.env.HOME}/Library/LaunchAgents/${label}.plist`;
      const uid = process.getuid?.() ?? 0;
      const args = cmd === "stop" ? ["bootout", `gui/${uid}/${label}`] : ["bootstrap", `gui/${uid}`, plist];
      await new Promise<void>((resolve, reject) => execFile("/bin/launchctl", args, (err, _o, stderr) => (err && !(cmd === "stop" && /No such process|not find/i.test(String(stderr))) ? reject(new Error(`launchctl ${args[0]} failed: ${String(stderr).trim() || err.message}`)) : resolve())));
      return out(cmd === "stop" ? "Jarvis service stopped. Start it again with: jarvis start" : "Jarvis service started.");
    }
    case "backup": {
      const stateDir = arg("state-dir", argv);
      const app = new App({ ...(stateDir ? { stateDir } : {}), quiet: true });
      const r = await createBackup(app, arg("out", argv));
      app.db.close();
      return out(JSON.stringify({ path: r.path, bytes: r.bytes, manifest: r.manifest }));
    }
    case "restore": {
      const file = argv[1];
      if (!file || !existsSync(file)) throw new Error("Usage: jarvis restore <backup.tar.gz> [--data-folder <path>] [--force]");
      const paths = resolvePaths(arg("state-dir", argv));
      const rt = readRuntime(paths.runtimeFile);
      if (rt && alive(rt.pid)) throw new Error(`The Jarvis service is running (pid ${rt.pid}). Run \`jarvis stop\` first, then restore, then \`jarvis start\`.`);
      const dataFolder = arg("data-folder", argv);
      const r = await restoreBackup(file, { stateDir: paths.stateDir, ...(dataFolder ? { dataFolder } : {}), force: argv.includes("--force") });
      return out(JSON.stringify({ restored: true, dataFolder: r.dataFolder, from: r.manifest.createdAt, reconnect: r.manifest.connectionsNeedingReconnect }));
    }
    default:
      throw new Error(`Unknown command ${cmd}. Commands: serve, start, stop, pair, status, backup, restore, version`);
  }
}

main().catch((e) => {
  process.stderr.write(`jarvis: ${(e as Error).message}\n`);
  process.exit(1);
});
