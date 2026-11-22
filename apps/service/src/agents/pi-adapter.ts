import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HarnessFileChange, HarnessStatusReport } from "@attache/contracts";
import { locationsForHome } from "../platform/locations.ts";
import { PI_AGENT_DIR, piInstall } from "../platform/harness-locations.ts";
import { HooksFileError, replaceFile, writeConfigText } from "./hooks-config.ts";
import { readHarnessJson } from "./harness-json.ts";
import { agentHome, hookScript, mcpServerEntry, stablePath, type AgentHooks } from "./install.ts";
import type { HarnessAdapter } from "./harness-adapters.ts";

/**
 * Pi (earendil-works/pi) through its official extension API (ADR 0006).
 *
 * Attache owns one extension file per instance in Pi's global extensions
 * folder, which Pi loads on its own. Each time Pi loads it, the extension
 * registers this instance's MCP server with `pi.registerMcpServer`, which Pi
 * keeps for that session only: nothing is added to the owner's `mcp.json` or
 * `settings.json`, so there is never a second, persistent copy to drift.
 * Attache reads those two files only to refuse a setup in which the
 * registration could not work.
 *
 * The same extension gives each model call the Brain's current memory: Pi's
 * `context` event runs before every call, and the extension puts the session
 * context the service keeps (the hook script's `sessionContext`) ahead of the
 * conversation for that call only. Pi does not save what a `context` handler
 * adds, so a resumed or compacted session never carries old memory, and
 * session capture never reads it as the owner's words.
 *
 * And it saves sessions (session capture with a final event): when Pi
 * settles after a run (`agent_settled`), before each compaction and when a
 * session closes (`session_shutdown`, which Pi also runs on Ctrl+C, Ctrl+D,
 * SIGHUP and SIGTERM), it hands the hook script's `spoolSession` the
 * session's current branch, which the service normalises
 * (agents/pi-transcript.ts) and joins by entry id. Sessions without a file
 * (`--no-session`, which Pi's subagent example uses for its subagents) are
 * never saved; a clone or fork names the last entry it copied from its
 * parent, so the parent's turns are not saved twice.
 */

/**
 * Every version of the extension starts with `OWNER`, and its ownership line
 * names the instance; only the rest of the first line changes, so a file an
 * earlier version wrote is still recognised as this instance's.
 */
const OWNER = "// Managed by Attache: ";
const MARKER = `${OWNER}registers this Attache instance's MCP server, gives its memory to each Pi session and saves Pi sessions in it.`;
const INSTANCE = "// attache-instance: ";
const PURPOSE = "Attache's Pi extension, which registers Attache's MCP server, gives your Attache memory to each Pi session and saves your Pi sessions";

/**
 * How Attache's memory is marked in what Pi sends the model: a custom message
 * of this type whose text is wrapped in this tag. Pi does not save it, but a
 * transcript parser must still drop any custom message of this type, and
 * strip the tag from any text, should one ever reach a session file.
 */
export const PI_MEMORY_CUSTOM_TYPE = "attache-memory";
export const ATTACHE_MEMORY_TAG = "attache-memory";

/** Pi's agent folder: `PI_CODING_AGENT_DIR` when it names one, else `~/.pi/agent`. */
export function piAgentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR?.trim();
  if (env && isAbsolute(env)) return env;
  return join(agentHome(), ...PI_AGENT_DIR.split("/"));
}

/**
 * The extension text for one Attache instance: plain code Pi loads through
 * jiti, with no static imports. It loads this install's hook script only when
 * a model call needs memory, so a missing script costs the memory and never
 * the MCP registration.
 */
export function piExtensionText(stateDir: string, server: string, hook: string): string {
  const config = { ...mcpServerEntry(stateDir), description: "Attache: search, read and save to your Brain", exposure: "direct" };
  return [
    MARKER,
    "// Attache rewrites this file when you connect Pi again and removes it when you disconnect; edits here are lost.",
    `${INSTANCE}${JSON.stringify({ stateDir })}`,
    "",
    `const SERVER = ${JSON.stringify(server)};`,
    `const CONFIG = ${JSON.stringify(config, null, 2)};`,
    `const STATE_DIR = ${JSON.stringify(stateDir)};`,
    `const HOOK = ${JSON.stringify(pathToFileURL(hook).href)};`,
    `const MEMORY = ${JSON.stringify(PI_MEMORY_CUSTOM_TYPE)};`,
    "",
    "let hook;",
    "",
    "/** This install's hook script, which reads memory and spools sessions; null when Attache moved or is gone (tried again next time). */",
    "async function loadHook() {",
    "  try {",
    "    hook ??= import(HOOK);",
    "    return await hook;",
    "  } catch {",
    "    hook = undefined;",
    "    return null;",
    "  }",
    "}",
    "",
    "/** The Brain's current memory for a session in `folder`, or null; read from the files Attache keeps up to date. */",
    "async function memory(folder) {",
    "  try {",
    "    return (await loadHook())?.sessionContext(STATE_DIR, folder) ?? null;",
    "  } catch {",
    "    // Never break the session.",
    "    return null;",
    "  }",
    "}",
    "",
    "/** Entry ids of a parent session's file, by path; null when it cannot be read. */",
    "const parents = new Map();",
    "async function parentIds(path) {",
    "  if (!parents.has(path)) {",
    "    let ids = null;",
    "    try {",
    "      const { readFileSync } = await import(\"node:fs\");",
    "      ids = new Set(readFileSync(path, \"utf8\").split(\"\\n\").flatMap((l) => { try { const e = JSON.parse(l); return e && typeof e.id === \"string\" && e.type !== \"session\" ? [e.id] : []; } catch { return []; } }));",
    "    } catch {",
    "      // The parent is gone: this session's copy of its turns is then the only one.",
    "    }",
    "    parents.set(path, ids);",
    "  }",
    "  return parents.get(path);",
    "}",
    "",
    "/**",
    " * Hand the session's current branch to Attache, which saves the owner's and the assistant's words from it.",
    " * A session Pi keeps no file for (--no-session, as subagents run) is never saved.",
    " */",
    "async function save(event, ctx) {",
    "  try {",
    "    const sm = ctx && ctx.sessionManager;",
    "    if (!sm || !sm.getSessionFile()) return;",
    "    const header = sm.getHeader();",
    "    const entries = sm.getBranch();",
    "    let forkedAt = null;",
    "    // A clone or fork copies its parent's entries, ids and all; those were saved with the parent.",
    "    const inherited = header && typeof header.parentSession === \"string\" ? await parentIds(header.parentSession) : null;",
    "    if (inherited) for (const e of entries) if (inherited.has(e.id)) forkedAt = e.id;",
    "    const snapshot = { attache: \"pi-session\", v: 1, header, forkedAt, entries };",
    "    (await loadHook())?.spoolSession(STATE_DIR, { agent: \"pi\", event, sessionId: header.id, cwd: header.cwd ?? ctx.cwd ?? null }, JSON.stringify(snapshot));",
    "  } catch {",
    "    // Never break the session; the next run saves it again.",
    "  }",
    "}",
    "",
    "export default function attache(pi) {",
    "  pi.registerMcpServer(SERVER, CONFIG);",
    "  // Before every model call: drop any earlier copy of Attache's memory, then put the current one first. Pi does not save it.",
    "  pi.on(\"context\", async (event, ctx) => {",
    "    const messages = event.messages.filter((m) => !(m && m.role === \"custom\" && m.customType === MEMORY));",
    "    const text = await memory(ctx && ctx.cwd ? ctx.cwd : process.cwd());",
    "    if (!text) return messages.length === event.messages.length ? undefined : { messages };",
    `    const content = "<${ATTACHE_MEMORY_TAG}>\\n" + text.trim() + "\\n</${ATTACHE_MEMORY_TAG}>";`,
    "    return { messages: [{ role: \"custom\", customType: MEMORY, content, display: false, timestamp: 0 }, ...messages] };",
    "  });",
    "  // When Pi is done with a prompt and will not go on by itself: the end of a turn.",
    "  pi.on(\"agent_settled\", (_event, ctx) => save(\"turn-end\", ctx));",
    "  pi.on(\"session_before_compact\", (_event, ctx) => save(\"pre-compact\", ctx));",
    "  // Pi closes a session on quitting (Ctrl+C, Ctrl+D, SIGHUP, SIGTERM) and when switching, forking or reloading; a reload goes on with the same session.",
    "  pi.on(\"session_shutdown\", (event, ctx) => save(event && event.reason === \"reload\" ? \"turn-end\" : \"session-end\", ctx));",
    "}",
    "",
  ].join("\n");
}

/** The state folder an Attache extension file belongs to, or null for a file Attache did not write. */
function instanceOf(text: string): string | null {
  if (!text.startsWith(OWNER)) return null;
  const line = text.split("\n").find((l) => l.startsWith(INSTANCE));
  try {
    const parsed = JSON.parse(line?.slice(INSTANCE.length) ?? "") as { stateDir?: unknown };
    return typeof parsed.stateDir === "string" ? parsed.stateDir : null;
  } catch {
    // A damaged marker line: not provably this instance's, so it is treated as the owner's.
    return null;
  }
}

/** A JSON file of Pi's, or undefined when it is absent; throws, naming the file, when Pi's own file does not parse. */
const readPiJson = (path: string) => readHarnessJson(path, "Pi")?.value;

/** Pi treats server names that differ only in `-` and `_` as one server. */
const sameServer = (a: string, b: string) => a.replace(/_/g, "-").toLowerCase() === b.replace(/_/g, "-").toLowerCase();

export function piAdapter(hooks: AgentHooks): HarnessAdapter {
  const server = () => hooks.ownerKey();
  const extension = () => join(piAgentDir(), "extensions", `${server()}.ts`);
  const expected = () => piExtensionText(hooks.stateDir, server(), stablePath(hookScript()));

  /** Throws, naming the file, when Pi's setup would refuse or hide this instance's registration. */
  function checkPiSetup() {
    const settingsPath = join(piAgentDir(), "settings.json");
    const settings = readPiJson(settingsPath);
    const extensions = settings?.extensions;
    if (Array.isArray(extensions) && extensions.some((e) => e === "-builtin:mcp" || e === "!builtin:mcp")) {
      throw new HooksFileError(`${settingsPath} turns off Pi's built-in MCP support ("-builtin:mcp"), so Pi would reject Attache's MCP server. Remove that entry, then connect again. Attache changed nothing.`);
    }
    const mcpPath = join(piAgentDir(), "mcp.json");
    const servers = readPiJson(mcpPath)?.mcpServers;
    const clash = servers && typeof servers === "object" ? Object.keys(servers).find((n) => sameServer(n, server())) : undefined;
    if (clash) throw new HooksFileError(`${mcpPath} already defines a server named "${clash}", which Pi uses instead of Attache's. Remove or rename it, then connect again. Attache changed nothing.`);
  }

  /** The extension file's text when it is this instance's, null when absent; throws when another file is in its place. */
  function current(): string | null {
    const path = extension();
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    if (instanceOf(text) !== hooks.stateDir) throw new HooksFileError(`${path} exists and was not written by this Attache; Attache will not change it. Move it away, then connect again.`);
    return text;
  }

  function plan(): HarnessFileChange[] {
    checkPiSetup();
    const text = current();
    if (text === expected()) return [];
    return [{ path: extension(), change: text === null ? "create" : "update", backup: text !== null, purpose: PURPOSE }];
  }

  const restartRequired = true;
  const adapter: HarnessAdapter = {
    kind: "pi",
    label: "Pi",
    capabilities: { mcp: true, memory: "runtime-fresh", capture: "with-final-event" },
    restartRequired,
    manualSetup: true,
    setupNote:
      "Attache adds one extension to Pi's extensions folder that registers Attache's MCP server each time Pi starts a session, for that session only, and sends your current Attache memory with every model call without saving it in the session, so resumed and compacted sessions always see today's memory; your Pi settings, mcp.json and other extensions are not changed. It also saves your Pi sessions as they go: each time Pi finishes a prompt, before each compaction and when a session closes, Attache keeps your words and Pi's answers, never tool output, Attache's memory, other extensions' messages or sessions run with --no-session, such as subagents. Pi reports closing on Ctrl+C, Ctrl+D and when it is stopped, so only the newest turn of a Pi that is killed or crashes can be missed. Memory and saving need the Agent sessions feature on. Needs Pi 0.99.0 or later with its built-in MCP support on. Run /reload in a Pi session that is already open, or start a new one. If Pi was not found, you can still connect: Attache uses ~/.pi/agent, or PI_CODING_AGENT_DIR when the Attache service has it set.",
    detect: (home) => (process.env.PI_CODING_AGENT_DIR ? true : piInstall(locationsForHome(home)).presence.some((p) => existsSync(p))),
    preview: () => ({ changes: plan(), restartRequired }),
    apply: () => {
      const changes = plan();
      const backups: string[] = [];
      for (const c of changes) {
        if (c.change === "create") replaceFile(c.path, expected());
        else {
          const { backup } = writeConfigText(c.path, expected(), hooks.backupDir);
          if (backup) backups.push(backup);
        }
      }
      return { changes, backups, restartRequired };
    },
    status: (): HarnessStatusReport => {
      const path = extension();
      try {
        checkPiSetup();
        const text = current();
        if (text === null) return { state: "missing", message: `Attache's Pi extension is not in ${path}. Set up again to fix it.`, files: [] };
        if (text !== expected()) return { state: "stale", message: `Attache's Pi extension ${path} is out of date. Set up again to fix it.`, files: [path] };
        return { state: "current", message: `Attache's Pi extension ${path}, which registers Attache's MCP server, gives your memory to and saves each Pi session`, files: [path] };
      } catch (e) {
        return { state: "failed", message: (e as Error).message, files: [] };
      }
    },
    refresh: () => adapter.apply(),
    uninstall: () => {
      const path = extension();
      try {
        if (!existsSync(path) || instanceOf(readFileSync(path, "utf8")) !== hooks.stateDir) return { removed: [], failures: [] };
        rmSync(path);
        return { removed: [{ path, change: "remove", backup: false, purpose: PURPOSE }], failures: [] };
      } catch (e) {
        return { removed: [], failures: [`Could not remove ${path}: ${(e as Error).message}`] };
      }
    },
  };
  return adapter;
}
