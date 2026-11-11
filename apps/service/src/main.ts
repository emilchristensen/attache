import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFile } from "node:child_process";
import { App, VERSION } from "./app.ts";
import { startServer } from "./http/server.ts";
import { createPairingCode } from "./http/security.ts";
import { resolvePaths } from "./core/paths.ts";
import { openDb } from "./core/db.ts";
import { createBackup, restoreBackup } from "./backup.ts";
import { ConfigStore } from "./core/config.ts";
import { RECALL_EXCLUDE, search } from "./memory/search.ts";
import { AgentHooks } from "./agents/install.ts";
import { AGENT_INTEGRATIONS, integrationFor } from "./agents/integrations.ts";
import { alive, readRuntime, type Runtime } from "./cli/client.ts";
import { auditCommand, saveCommand, type CliIo } from "./cli/memory-commands.ts";
import { runMcpServer } from "./mcp/server.ts";
import { evaluateRecallCommand } from "./cli/recall-evaluation-command.ts";

export const DEFAULT_PORT = 7427;

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
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

/** Recall from a shell, for coding agents: top hits with file, lines and a snippet. Reads the index; never writes. */
async function searchCmd(argv: string[]) {
  const query = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--state-dir" && all[i - 1] !== "--limit").join(" ").trim();
  if (!query) throw new Error('Usage: jarvis search "your query" [--limit 8] [--json]');
  const paths = resolvePaths(arg("state-dir", argv));
  const db = openDb(paths.dbFile);
  try {
    const dataFolder = new ConfigStore(db).get().dataFolder;
    const roots = new Map((db.prepare("select id, settings from connections where kind = 'vault'").all() as Array<{ id: string; settings: string }>).map((r) => [`import:${r.id}`, String((JSON.parse(r.settings) as { path?: string }).path ?? "")]));
    const hits = search(db, query, { limit: Math.min(Number(arg("limit", argv) ?? 8), 30), excludePrefixes: RECALL_EXCLUDE }).map((h) => ({
      file: h.root === "data" && dataFolder ? `${dataFolder}/${h.relPath}` : `${roots.get(h.root) ?? h.root}/${h.relPath}`,
      lines: [h.startLine, h.endLine],
      title: h.title,
      snippet: h.snippet,
    }));
    if (argv.includes("--json")) return out(JSON.stringify(hits));
    if (!hits.length) return out(`No matches for "${query}".`);
    out(hits.map((h) => `${h.file}:${h.lines[0]}-${h.lines[1]}  ${h.title}\n    ${h.snippet}`).join("\n"));
  } finally {
    db.close();
  }
}

/** Inspect or remove this install's coding-agent hooks (the uninstaller calls `agent-hooks uninstall`). */
async function agentHooksCmd(argv: string[]) {
  const paths = resolvePaths(arg("state-dir", argv));
  const hooks = new AgentHooks(paths.stateDir, paths.backupsDir);
  const sub = argv[1] ?? "status";
  const only = arg("agent", argv);
  const picked = only ? integrationFor(only) : null;
  if (only && !picked) throw new Error(`Unknown agent ${only}. Agents: ${AGENT_INTEGRATIONS.map((a) => a.kind).join(", ")}`);
  const agents = picked ? [picked] : AGENT_INTEGRATIONS;
  if (sub === "status") {
    return out(JSON.stringify(agents.map((a) => {
      const s = hooks.status(a);
      return { agent: a.kind, path: s.path, hooks: s.installed.length, current: s.current, rules: s.rules, skills: s.skills };
    })));
  }
  if (sub === "uninstall") {
    const results = hooks.uninstallAll(agents);
    out(JSON.stringify(results));
    const failed = results.filter((r) => r.error);
    if (failed.length) throw new Error(`Could not remove the Jarvis hooks from ${failed.map((f) => `${f.path} (${f.error})`).join("; ")}. Remove the entries that mention jarvis-agent-hook by hand.`);
    return;
  }
  throw new Error("Usage: jarvis agent-hooks status|uninstall [--agent claude-code|codex|antigravity]");
}

function cliIo(): CliIo {
  return { out, readStdin: () => (process.stdin.isTTY ? "" : readFileSync(0, "utf8")), cwd: process.cwd(), env: process.env };
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
    case "search":
      return searchCmd(argv);
    case "agent-hooks":
      return agentHooksCmd(argv);
    case "save":
      return saveCommand(argv, resolvePaths(arg("state-dir", argv)), cliIo());
    case "audit":
      return auditCommand(argv, resolvePaths(arg("state-dir", argv)), cliIo());
    case "mcp":
      return runMcpServer(resolvePaths(arg("state-dir", argv)), VERSION);
    case "evaluate-recall":
      return evaluateRecallCommand(argv, resolvePaths(arg("state-dir", argv)), cliIo());
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
      throw new Error(`Unknown command ${cmd}. Commands: serve, start, stop, pair, status, search, save, audit, evaluate-recall, mcp, agent-hooks, backup, restore, version`);
  }
}

main().catch((e) => {
  process.stderr.write(`jarvis: ${(e as Error).message}\n`);
  process.exit(1);
});
