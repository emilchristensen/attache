import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { App, VERSION } from "./app.ts";
import { startServer } from "./http/server.ts";
import { createPairingCode } from "./http/security.ts";
import { resolvePaths } from "./core/paths.ts";
import { openDb } from "./core/db.ts";
import { createBackup, restoreBackup } from "./backup.ts";
import { ConfigStore } from "./core/config.ts";
import { RECALL_EXCLUDE, searchByMeaning } from "./memory/search.ts";
import { unverifiedLabel } from "./memory/review-date.ts";
import { configuredMeaningModel } from "./meaning/model.ts";
import { meaningNote } from "./meaning/note.ts";
import { MeaningSearch } from "./meaning/service.ts";
import { loadOnnxEmbedder } from "./meaning/onnx-embedder.ts";
import { createLogger } from "./core/log.ts";
import { AgentHooks } from "./agents/install.ts";
import { copilotCliAdapter } from "./agents/copilot-cli-adapter.ts";
import { openCodeAdapter } from "./agents/opencode-adapter.ts";
import { piAdapter } from "./agents/pi-adapter.ts";
import { AGENT_INTEGRATIONS, integrationFor } from "./agents/integrations.ts";
import { alive, readRuntime, type Runtime } from "./cli/client.ts";
import { auditCommand, type CliIo } from "./cli/memory-commands.ts";
import { credentialsCommand, dataFolderCommand, locksCommand, notificationsCommand, pathsCommand, serviceCommand, wrappersCommand, type PlatformCliIo } from "./cli/platform-commands.ts";
import { currentOs } from "./platform/os.ts";
import { openUrl } from "./platform/open-url.ts";
import { writeFileWhole } from "./platform/replace-file.ts";
import { runMcpServer } from "./mcp/server.ts";
import { evaluateRecallCommand } from "./cli/recall-evaluation-command.ts";
import { replicationCommand } from "./cli/replication-commands.ts";
import { gitCredentialCommand } from "./cli/git-credential-command.ts";

export const DEFAULT_PORT = 7427;

function arg(name: string, argv: string[]): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

const out = (s: string) => process.stdout.write(s + "\n");

async function serve(argv: string[]) {
  const stateDir = arg("state-dir", argv);
  const port = Number(arg("port", argv) ?? process.env.ATTACHE_PORT ?? DEFAULT_PORT);
  const app = new App({ ...(stateDir ? { stateDir } : {}) });
  const handle = await startServer(app, { port });
  app.start();
  const runtime: Runtime = { pid: process.pid, port: handle.port, url: handle.url, version: VERSION, startedAt: app.startedAt, instance: app.instance };
  // Whole or not at all: the CLI reads it, and may be reading it while the service starts.
  writeFileWhole(app.paths.runtimeFile, JSON.stringify(runtime, null, 2), { mode: 0o600 });
  app.log.info("attache service listening", { url: handle.url, version: VERSION, stateDir: app.paths.stateDir });
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
  // Under the Windows logon task's supervisor (`attache service run`): stop when it closes the channel or dies.
  if (process.channel) {
    process.channel.unref();
    process.on("disconnect", () => void stop("supervisor gone"));
  }
}

async function pair(argv: string[]) {
  const paths = resolvePaths(arg("state-dir", argv));
  const db = openDb(paths.dbFile);
  const { code, expiresAt } = createPairingCode(db, "setup");
  db.close();
  const rt = readRuntime(paths.runtimeFile);
  const port = rt?.port ?? Number(process.env.ATTACHE_PORT ?? DEFAULT_PORT);
  const url = `http://127.0.0.1:${port}/pair#code=${code}`;
  if (argv.includes("--json")) out(JSON.stringify({ code, url, expiresAt }));
  else out(`Pairing code: ${code} (expires ${expiresAt})\nOpen: ${url}`);
  if (argv.includes("--open")) openUrl(currentOs(), url);
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

/** Recall from a shell, for a Harness: top hits with file, lines and a snippet. Reads the index; never writes. */
async function searchCmd(argv: string[]) {
  const query = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--state-dir" && all[i - 1] !== "--limit").join(" ").trim();
  if (!query) throw new Error('Usage: attache search "your query" [--limit 8] [--json]');
  const paths = resolvePaths(arg("state-dir", argv));
  const db = openDb(paths.dbFile);
  // Ranks by meaning with the model and vectors this Machine already has; it never downloads or builds them.
  const meaning = new MeaningSearch({ db, modelsDir: paths.modelsDir, log: createLogger(null, { quiet: true }), emit: () => {} }, { model: configuredMeaningModel(), loadEmbedder: loadOnnxEmbedder });
  try {
    const dataFolder = new ConfigStore(db).get().dataFolder;
    const roots = new Map((db.prepare("select id, settings from connections where kind = 'vault'").all() as Array<{ id: string; settings: string }>).map((r) => [`import:${r.id}`, String((JSON.parse(r.settings) as { path?: string }).path ?? "")]));
    const found = await searchByMeaning(db, query, (q, n) => meaning.nearest(q, n), { limit: Math.min(Number(arg("limit", argv) ?? 8), 30), excludePrefixes: RECALL_EXCLUDE });
    const hits = found.map((h) => ({
      // An absolute path in this operating system's own form, which a Harness can open as it is.
      file: join(h.root === "data" && dataFolder ? dataFolder : (roots.get(h.root) ?? h.root), ...h.relPath.split("/")),
      lines: [h.startLine, h.endLine],
      title: h.title,
      snippet: h.snippet,
      review: h.review,
      unverified: h.unverified,
    }));
    // This command searches the index itself, so it says why results match keywords only, as the MCP server and the Dashboard do.
    const note = meaningNote(meaning.status());
    if (argv.includes("--json")) {
      // The JSON stays a list of hits for scripts; the note goes beside it, on stderr.
      if (note) process.stderr.write(`${note}\n`);
      return out(JSON.stringify(hits));
    }
    if (note) out(note);
    if (!hits.length) return out(`No matches for "${query}".`);
    out(hits.map((h) => `${h.file}:${h.lines[0]}-${h.lines[1]}  ${h.title}${h.unverified && h.review ? `  (${unverifiedLabel(h.review)})` : ""}\n    ${h.snippet}`).join("\n"));
  } finally {
    await meaning.stop();
    db.close();
  }
}

/** Inspect or remove this install's hooks and MCP server in each Harness (the uninstaller calls `agent-hooks uninstall`). */
async function agentHooksCmd(argv: string[]) {
  const paths = resolvePaths(arg("state-dir", argv));
  const hooks = new AgentHooks(paths.stateDir, paths.backupsDir);
  const sub = argv[1] ?? "status";
  const only = arg("agent", argv);
  const picked = only ? integrationFor(only) : null;
  // Pi, OpenCode and Copilot CLI are connected through their own adapters (one extension or plugin file, or one MCP entry), not hooks and an MCP configuration.
  const fileAdapters = [piAdapter(hooks), openCodeAdapter(hooks), copilotCliAdapter(hooks)];
  const kinds = [...AGENT_INTEGRATIONS.map((a) => a.kind), ...fileAdapters.map((a) => a.kind)];
  if (only && !kinds.includes(only)) throw new Error(`Unknown agent ${only}. Agents: ${kinds.join(", ")}`);
  const agents = picked ? [picked] : only ? [] : AGENT_INTEGRATIONS;
  const adapters = fileAdapters.filter((a) => !only || only === a.kind);
  if (sub === "status") {
    return out(JSON.stringify([
      ...agents.map((a) => {
        const s = hooks.status(a);
        return { agent: a.kind, path: s.path, hooks: s.installed.length, mcp: s.mcp.registered ? s.mcp.path : null, current: s.current, rules: s.rules };
      }),
      ...adapters.map((a) => (({ state, files }) => ({ agent: a.kind, path: files[0] ?? null, state, current: state === "current" }))(a.status())),
    ]));
  }
  if (sub === "uninstall") {
    const results = [
      ...hooks.uninstallAll(agents),
      ...adapters.map((a) => (({ removed, failures }) => ({ agent: a.kind, path: removed[0]?.path ?? null, removed: removed.length, mcp: null, ...(failures.length ? { error: failures.join(" ") } : {}) }))(a.uninstall())),
    ];
    out(JSON.stringify(results));
    const failed = results.filter((r) => r.error);
    if (failed.length) throw new Error(`Could not remove the Attache hooks from ${failed.map((f) => `${f.path} (${f.error})`).join("; ")}. Remove the hooks that mention attache-agent-hook and the MCP server that runs \`attache mcp\` by hand.`);
    return;
  }
  throw new Error(`Usage: attache agent-hooks status|uninstall [--agent ${kinds.join("|")}]`);
}

function cliIo(): CliIo {
  return { out, cwd: process.cwd() };
}

function platformIo(argv: string[]): PlatformCliIo {
  return { out, arg: (name) => arg(name, argv), defaultPort: DEFAULT_PORT };
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "serve";
  // Refuse an unsupported operating system up front, with a message instead of a failure halfway through.
  if (cmd !== "version") currentOs();
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
    case "audit":
      return auditCommand(argv, resolvePaths(arg("state-dir", argv)), cliIo());
    case "mcp":
      return runMcpServer(resolvePaths(arg("state-dir", argv)), VERSION);
    case "replication":
      return replicationCommand(argv, resolvePaths(arg("state-dir", argv)), cliIo());
    case "git-credential":
      return gitCredentialCommand(argv, resolvePaths(arg("state-dir", argv)), { readStdin: () => readFileSync(0, "utf8"), write: (t) => process.stdout.write(t) });
    case "evaluate-recall":
      return evaluateRecallCommand(argv, resolvePaths(arg("state-dir", argv)), cliIo());
    case "stop":
    case "start":
      return serviceCommand(cmd, platformIo(argv));
    case "service":
      return serviceCommand(argv[1], platformIo(argv));
    case "wrappers":
      return wrappersCommand(argv[1], platformIo(argv));
    case "credentials":
      return credentialsCommand(argv[1], platformIo(argv));
    case "notifications":
      return notificationsCommand(argv[1], platformIo(argv));
    case "locks":
      return locksCommand(argv[1], platformIo(argv));
    case "paths":
      return pathsCommand(argv[1], platformIo(argv));
    case "data-folder":
      return dataFolderCommand(platformIo(argv));
    case "backup": {
      const stateDir = arg("state-dir", argv);
      const app = new App({ ...(stateDir ? { stateDir } : {}), quiet: true });
      const dest = arg("out", argv);
      const r = await createBackup(app, dest ? { dest } : {});
      app.db.close();
      return out(JSON.stringify({ path: r.path, bytes: r.bytes, manifest: r.manifest }));
    }
    case "restore": {
      const file = argv[1];
      if (!file || !existsSync(file)) throw new Error("Usage: attache restore <backup.tar.gz> [--data-folder <path>] [--force]");
      const paths = resolvePaths(arg("state-dir", argv));
      const rt = readRuntime(paths.runtimeFile);
      if (rt && alive(rt.pid)) throw new Error(`The Attache service is running (pid ${rt.pid}). Run \`attache stop\` first, then restore, then \`attache start\`.`);
      const dataFolder = arg("data-folder", argv);
      const r = await restoreBackup(file, { stateDir: paths.stateDir, ...(dataFolder ? { dataFolder } : {}), force: argv.includes("--force") });
      return out(JSON.stringify({ restored: true, dataFolder: r.dataFolder, from: r.manifest.createdAt, reconnect: r.manifest.connectionsNeedingReconnect }));
    }
    default:
      throw new Error(`Unknown command ${cmd}. Commands: serve, start, stop, pair, status, search, audit, evaluate-recall, replication, mcp, agent-hooks, backup, restore, version, service, wrappers, credentials, notifications, locks, paths, data-folder`);
  }
}

main().catch((e) => {
  process.stderr.write(`attache: ${(e as Error).message}\n`);
  process.exit(1);
});
