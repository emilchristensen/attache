import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { HarnessApplyResult, HarnessFileChange, HarnessStatusReport } from "@attache/contracts";
import { OPENCODE_CONFIG_DIR } from "../platform/harness-locations.ts";
import { HooksFileError, replaceFile, writeConfigText } from "./hooks-config.ts";
import { withHarnessSessionState, type RootedHarnessAdapter } from "./harness-session-state.ts";
import { readHarnessJson } from "./harness-json.ts";
import { agentHome, hookScript, mcpServerEntry, stablePath, type AgentHooks } from "./install.ts";
import type { HarnessAdapter } from "./harness-adapters.ts";
import { parseJsonc } from "./jsonc.ts";
import { checkOpenCodeVersion, openCodeFound } from "./opencode-version.ts";
import { ATTACHE_MEMORY_TAG } from "./pi-adapter.ts";

/**
 * OpenCode through its official plugin API (ADR 0006).
 *
 * Attache owns one plugin file per instance in OpenCode's global plugins
 * folder, which OpenCode 1 and OpenCode 2 both load on their own. The file
 * carries both plugin entry points: OpenCode 1 calls `server()` and runs its
 * `config` hook, OpenCode 2 reads `id` and runs `setup(ctx)`. Each registers
 * this instance's MCP server in OpenCode's in-memory configuration, so the
 * owner's `opencode.json(c)` is never written and there is no second,
 * persistent copy to drift. Attache reads those files only to refuse a setup
 * in which the registration could not work.
 *
 * The same plugin gives each model call the Brain's current memory: OpenCode
 * 1's `experimental.chat.system.transform` and OpenCode 2's `context` session
 * hook run before every agent-loop call, and the plugin adds the session
 * context the service keeps (the hook script's `sessionContext`) to that
 * call's system prompt only, wrapped in <attache-memory> tags. Neither
 * OpenCode saves the system prompt, so a resumed or compacted session never
 * carries old memory and session capture never reads it as the owner's words.
 * OpenCode 1 also runs the transform for its compaction summary; the plugin
 * skips that one call so no summary restates memory that later goes stale.
 * OpenCode 2 summarises through a separate hook that adds no memory.
 *
 * And it saves sessions (session capture without a final event: OpenCode has
 * no session end). When a turn ends (OpenCode 1's idle `session.status`
 * event, OpenCode 2's `experimental.idle` hook) and before each compaction,
 * it hands the hook script's `spoolSession` a snapshot of the session's
 * messages, which the service normalises (agents/opencode-transcript.ts).
 * OpenCode 2 hands a plugin only the messages since the last compaction, so
 * the compaction snapshot holds the ones about to leave it; the service joins
 * snapshots by message id. Subagent sessions are never saved, and a last save
 * runs when OpenCode unloads the plugin.
 */

/**
 * Every version of the plugin starts with `OWNER`, and its ownership line
 * names the instance; only the rest of the first line changes, so a file an
 * earlier version wrote is still recognised as this instance's.
 */
const OWNER = "// Managed by Attache: ";
const MARKER = `${OWNER}registers this Attache instance's MCP server, gives its memory to each OpenCode session and saves OpenCode sessions in it.`;
const INSTANCE = "// attache-instance: ";
const PURPOSE = "Attache's OpenCode plugin, which registers Attache's MCP server, gives your Attache memory to each OpenCode session and saves your OpenCode sessions";

/**
 * OpenCode's global config folder: `OPENCODE_CONFIG_DIR` when it names one
 * (OpenCode 2 uses it instead of the global folder, OpenCode 1 in addition),
 * else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`.
 */
export function openCodeConfigDir(): string {
  const dir = process.env.OPENCODE_CONFIG_DIR?.trim();
  if (dir && isAbsolute(dir)) return dir;
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  if (xdg && isAbsolute(xdg)) return join(xdg, "opencode");
  return join(agentHome(), ...OPENCODE_CONFIG_DIR.split("/"));
}

/**
 * The plugin text for one Attache instance: plain ES module code with no
 * static imports, so it needs no npm install. It loads this install's hook
 * script only when a model call needs memory, so a missing script costs the
 * memory and never the MCP registration.
 */
export function openCodePluginText(stateDir: string, id: string, hook: string): string {
  const entry = mcpServerEntry(stateDir);
  const command = [entry.command, ...entry.args];
  return [
    MARKER,
    "// Attache rewrites this file when you connect OpenCode again and removes it when you disconnect; edits here are lost.",
    `${INSTANCE}${JSON.stringify({ stateDir })}`,
    "",
    `const ID = ${JSON.stringify(id)};`,
    `const COMMAND = ${JSON.stringify(command)};`,
    `const STATE_DIR = ${JSON.stringify(stateDir)};`,
    `const HOOK = ${JSON.stringify(pathToFileURL(hook).href)};`,
    "",
    "let hook;",
    "",
    "/** This install's hook script, which reads memory and spools sessions; null when Attache moved or is gone (tried again next time). */",
    "async function attache() {",
    "  try {",
    "    hook ??= import(HOOK);",
    "    return await hook;",
    "  } catch {",
    "    hook = undefined;",
    "    return null;",
    "  }",
    "}",
    "",
    "/** The Brain's current memory for a session in `folder`, wrapped in Attache's tag, or null; read from the files Attache keeps up to date. */",
    "async function memory(folder) {",
    "  let text;",
    "  try {",
    '    text = (await attache())?.harnessSessionContext(STATE_DIR, "opencode", folder || process.cwd());',
    "  } catch {",
    "    // Never break the session.",
    "    return null;",
    "  }",
    `  return text && text.trim() ? "<${ATTACHE_MEMORY_TAG}>\\n" + text.trim() + "\\n</${ATTACHE_MEMORY_TAG}>" : null;`,
    "}",
    "",
    "/** OpenCode's answers come as `{ data }` from its client and plain from plugin domains. */",
    "const data = (r) => (r && typeof r === 'object' && !Array.isArray(r) && 'data' in r ? r.data : r);",
    "",
    "/**",
    " * Hand one snapshot of a session to Attache, which saves the owner's and the assistant's words from it.",
    " * `info` is OpenCode's session record: a subagent's session (it has a parent) is never saved.",
    " */",
    "async function save(event, info, opencode, shape, messages, folder) {",
    "  if (!info || info.parentID || !Array.isArray(messages)) return false;",
    "  const directory = (info.location && info.location.directory) || info.directory || folder || null;",
    '  const snapshot = { attache: "opencode-session", v: 1, opencode, shape, sessionID: info.id, parentID: null, title: info.title ?? null, directory, messages };',
    '  (await attache())?.spoolSession(STATE_DIR, { agent: "opencode", event, sessionId: info.id, cwd: directory }, JSON.stringify(snapshot));',
    "  return true;",
    "}",
    "",
    "export default {",
    "  id: ID,",
    "  async setup(ctx) {",
    "    const folder = ctx.location && ctx.location.directory;",
    "    // OpenCode 2: plugins manage MCP servers through transforms, which OpenCode drops when the plugin unloads.",
    '    await ctx.mcp.transform((mcp) => mcp.set(ID, { type: "local", command: COMMAND, codemode: false }));',
    "    // Before every agent-loop call of a session in this plugin's folder; OpenCode 2 does not save what it adds.",
    '    await ctx.session.hook("context", async (event) => {',
    "      const text = await memory(folder);",
    '      if (text) event.system.push({ type: "text", text });',
    "    });",
    "    // Sessions saved since the plugin loaded, saved once more when it unloads.",
    "    const seen = new Set();",
    '    const saveContext = async (sessionID, event = "turn-end") => {',
    "      try {",
    "        const info = data(await ctx.session.get({ sessionID }));",
    "        // The context holds the messages since the last compaction; the compaction hook below saved the ones before.",
    '        if (await save(event, info && { ...info, id: info.id ?? sessionID }, 2, "v2-context", data(await ctx.session.context({ sessionID })), folder)) seen.add(sessionID);',
    "      } catch {",
    "        // Never break the session; the next turn saves it again.",
    "      }",
    "    };",
    "    // When a session finishes its model work and goes idle: the end of a turn.",
    '    await ctx.session.hook("experimental.idle", async (event) => saveContext(event.sessionID));',
    "    // Before compaction, take the typed session context. The model request can include injected user-role text.",
    '    await ctx.session.hook("compaction", async (event) => saveContext(event.sessionID, "pre-compact"));',
    "    return async () => {",
    "      for (const sessionID of seen) await saveContext(sessionID);",
    "    };",
    "  },",
    "  // OpenCode 1 (1.18.29 and later).",
    "  async server(input) {",
    "    // Sessions whose next call is OpenCode's compaction summary, which gets no memory.",
    "    const compacting = new Set();",
    "    const seen = new Set();",
    "    /** Save the whole session: OpenCode 1 keeps every message, compacted or not. */",
    "    const saveSession = async (sessionID, event) => {",
    "      try {",
    "        const info = data(await input.client.session.get({ path: { id: sessionID } }));",
    '        if (await save(event, info && { ...info, id: info.id ?? sessionID }, 1, "v1-messages", data(await input.client.session.messages({ path: { id: sessionID } })), input.directory)) seen.add(sessionID);',
    "      } catch {",
    "        // Never break the session; the next turn saves it again.",
    "      }",
    "    };",
    "    return {",
    "      // Edits the configuration OpenCode is about to use.",
    "      async config(config) {",
    '        config.mcp = { ...(config.mcp ?? {}), [ID]: { type: "local", command: COMMAND, enabled: true } };',
    "      },",
    "      // A session going idle: the end of a turn.",
    "      async event({ event }) {",
    '        if (event && event.type === "session.status" && event.properties && event.properties.status && event.properties.status.type === "idle") await saveSession(event.properties.sessionID, "turn-end");',
    "      },",
    '      async "experimental.session.compacting"(event) {',
    "        compacting.add(event.sessionID);",
    '        await saveSession(event.sessionID, "pre-compact");',
    "      },",
    "      // Before every model call; OpenCode 1 does not save the system prompt.",
    '      async "experimental.chat.system.transform"(event, output) {',
    "        if (event.sessionID && compacting.delete(event.sessionID)) return;",
    "        const text = await memory(input && input.directory);",
    "        if (text) output.system.push(text);",
    "      },",
    "      // OpenCode unloading the plugin (an idle folder or a shutdown it finishes): a last save of what it saw.",
    "      async dispose() {",
    '        for (const sessionID of seen) await saveSession(sessionID, "turn-end");',
    "      },",
    "    };",
    "  },",
    "};",
    "",
  ].join("\n");
}

/** The state folder an Attache plugin file belongs to, or null for a file Attache did not write. */
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

/** OpenCode's own configuration files Attache checks: the global ones it reads, plus one `OPENCODE_CONFIG` names. */
function configFiles(): string[] {
  const dir = openCodeConfigDir();
  const explicit = process.env.OPENCODE_CONFIG?.trim();
  return [...["config.json", "opencode.json", "opencode.jsonc"].map((f) => join(dir, f)), ...(explicit && isAbsolute(explicit) ? [explicit] : [])];
}

/** A configuration file of OpenCode's (JSON with comments), or undefined when absent; throws, naming the file, when it does not parse. */
const readOpenCodeJson = (path: string) => readHarnessJson(path, "OpenCode", parseJsonc)?.value;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Whether a `plugins` entry names a plugin id the way OpenCode 2 matches them: exact, `*`, or an `id.*` prefix. */
const matchesId = (pattern: string, id: string) => pattern === "*" || (pattern.endsWith(".*") ? id.startsWith(pattern.slice(0, -1)) : pattern === id);

/** The OpenCode 2 `plugins` entry that leaves the plugin `id` turned off, or null when it stays on. */
function turnedOffBy(plugins: unknown, id: string): string | null {
  if (!Array.isArray(plugins)) return null;
  let off: string | null = null;
  for (const entry of plugins) {
    if (typeof entry !== "string") continue;
    if (entry.startsWith("-") && matchesId(entry.slice(1), id)) off = entry;
    else if (matchesId(entry, id)) off = null;
  }
  return off;
}

export function openCodeAdapter(hooks: AgentHooks): HarnessAdapter {
  const id = () => hooks.ownerKey();
  const plugin = (root = openCodeConfigDir(), owner = id()) => join(root, "plugins", `${owner}.js`);
  const expected = () => openCodePluginText(hooks.stateDir, id(), stablePath(hookScript()));

  /** The plugin file's text when it is this instance's, null when absent; throws when another file is in its place. */
  function current(): string | null {
    const path = plugin();
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    if (instanceOf(text) !== hooks.stateDir) throw new HooksFileError(`${path} exists and was not written by this Attache; Attache will not change it. Move it away, then connect again.`);
    return text;
  }

  /** Throws, naming the file, when OpenCode's configuration would turn off or replace this instance's registration. */
  function checkOpenCodeSetup(wait: boolean) {
    checkOpenCodeVersion(agentHome(), { wait });
    for (const path of configFiles()) {
      const config = readOpenCodeJson(path);
      if (!config) continue;
      const off = turnedOffBy(config.plugins, id());
      if (off) throw new HooksFileError(`${path} turns off Attache's plugin ("${off}") in its plugins list, so OpenCode would not load it. Remove that entry or add "${id()}" after it, then connect again. Attache changed nothing.`);
      const mcp = config.mcp;
      const servers = isObject(mcp) ? [mcp, ...(isObject(mcp.servers) ? [mcp.servers] : [])] : [];
      if (servers.some((s) => id() in s)) throw new HooksFileError(`${path} already defines an MCP server named "${id()}", which Attache's plugin would replace. Remove or rename it, then connect again. Attache changed nothing.`);
    }
  }

  /** `wait`: whether this may wait for OpenCode's version; only connecting does, never a status check or refresh. */
  function plan(wait: boolean): HarnessFileChange[] {
    checkOpenCodeSetup(wait);
    const text = current();
    if (text === expected()) return [];
    return [{ path: plugin(), change: text === null ? "create" : "update", backup: text !== null, purpose: PURPOSE }];
  }

  function write(changes: HarnessFileChange[]): HarnessApplyResult {
    const backups: string[] = [];
    for (const c of changes) {
      if (c.change === "create") replaceFile(c.path, expected());
      else {
        const { backup } = writeConfigText(c.path, expected(), hooks.backupDir);
        if (backup) backups.push(backup);
      }
    }
    return { changes, backups, restartRequired };
  }

  const restartRequired = true;
  const adapter: RootedHarnessAdapter = {
    kind: "opencode",
    label: "OpenCode",
    capabilities: { mcp: true, memory: "runtime-fresh", capture: "without-final-event" },
    restartRequired,
    manualSetup: true,
    setupNote:
      "Attache adds one plugin to OpenCode's global plugins folder that registers Attache's MCP server each time OpenCode loads it, and adds your current Attache memory to the system prompt of every model call without saving it in the session, so resumed and compacted sessions always see today's memory. The plugin also saves the conversation (your words and OpenCode's answers, never tool calls, tool output or Attache's memory) each time a turn ends and before each compaction. OpenCode has no session-end event, so the newest turn is saved only once it ends: a turn still running when OpenCode quits can be missed. Your opencode.json(c), MCP servers and other plugins are not changed. Memory and saving sessions need the Agent sessions feature on. Works with OpenCode 1 (1.18.29 or later) and OpenCode 2. Restart OpenCode after connecting (for OpenCode 2's background service, run opencode service restart). If OpenCode was not found, you can still connect: Attache uses ~/.config/opencode, or XDG_CONFIG_HOME or OPENCODE_CONFIG_DIR when the Attache service has them set.",
    detect: (home) => openCodeFound(home),
    preview: () => ({ changes: plan(true), restartRequired }),
    apply: () => write(plan(true)),
    status: (): HarnessStatusReport => {
      const path = plugin();
      try {
        checkOpenCodeSetup(false);
        const text = current();
        if (text === null) return { state: "missing", message: `Attache's OpenCode plugin is not in ${path}. Set up again to fix it.`, files: [] };
        if (text !== expected()) return { state: "stale", message: `Attache's OpenCode plugin ${path} is out of date. Set up again to fix it.`, files: [path] };
        return { state: "current", message: `Attache's OpenCode plugin ${path}, which registers Attache's MCP server, gives your Attache memory to each OpenCode session and saves your OpenCode sessions`, files: [path] };
      } catch (e) {
        return { state: "failed", message: (e as Error).message, files: [] };
      }
    },
    // The version was checked when the owner connected; a refresh (on every start) never waits for OpenCode.
    refresh: () => write(plan(false)),
    uninstall: ({ root, owner }) => {
      const path = plugin(root, owner);
      try {
        if (!existsSync(path) || instanceOf(readFileSync(path, "utf8")) !== hooks.stateDir) return { removed: [], failures: [] };
        rmSync(path);
        return { removed: [{ path, change: "remove", backup: false, purpose: PURPOSE }], failures: [] };
      } catch (e) {
        return { removed: [], failures: [`Could not remove ${path}: ${(e as Error).message}`] };
      }
    },
  };
  return withHarnessSessionState("opencode", adapter, hooks.stateDir, () => ({ root: openCodeConfigDir(), owner: id() }));
}
