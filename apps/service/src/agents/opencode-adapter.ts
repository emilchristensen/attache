import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { HarnessFileChange, HarnessStatusReport } from "@attache/contracts";
import { OPENCODE_CONFIG_DIR } from "../platform/harness-locations.ts";
import { HooksFileError, replaceFile, writeConfigText } from "./hooks-config.ts";
import { agentHome, mcpServerEntry, type AgentHooks } from "./install.ts";
import type { HarnessAdapter } from "./harness-adapters.ts";
import { parseJsonc } from "./jsonc.ts";
import { checkOpenCodeVersion, openCodeFound } from "./opencode-version.ts";

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
 */

const MARKER = "// Managed by Attache: registers this Attache instance's MCP server each time OpenCode loads this plugin.";
const INSTANCE = "// attache-instance: ";
const PURPOSE = "Attache's OpenCode plugin, which registers Attache's MCP server each time OpenCode loads it";

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

/** The plugin text for one Attache instance: plain ES module code with no imports, so it needs no npm install. */
export function openCodePluginText(stateDir: string, id: string): string {
  const entry = mcpServerEntry(stateDir);
  const command = [entry.command, ...entry.args];
  return [
    MARKER,
    "// Attache rewrites this file when you connect OpenCode again and removes it when you disconnect; edits here are lost.",
    `${INSTANCE}${JSON.stringify({ stateDir })}`,
    "",
    `const ID = ${JSON.stringify(id)};`,
    `const COMMAND = ${JSON.stringify(command)};`,
    "",
    "export default {",
    "  id: ID,",
    "  // OpenCode 2: plugins manage MCP servers through transforms, which OpenCode drops when the plugin unloads.",
    "  async setup(ctx) {",
    '    await ctx.mcp.transform((mcp) => mcp.set(ID, { type: "local", command: COMMAND, codemode: false }));',
    "  },",
    "  // OpenCode 1 (1.18.29 and later): the config hook edits the configuration OpenCode is about to use.",
    "  async server() {",
    "    return {",
    "      async config(config) {",
    '        config.mcp = { ...(config.mcp ?? {}), [ID]: { type: "local", command: COMMAND, enabled: true } };',
    "      },",
    "    };",
    "  },",
    "};",
    "",
  ].join("\n");
}

/** The state folder an Attache plugin file belongs to, or null for a file Attache did not write. */
function instanceOf(text: string): string | null {
  if (!text.startsWith(MARKER)) return null;
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
function readOpenCodeJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw);
  } catch (e) {
    throw new HooksFileError(`${path} is not valid JSON (${(e as Error).message}); fix it so OpenCode can read it, then connect again. Attache changed nothing.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new HooksFileError(`${path} does not contain a JSON object; fix it, then connect again. Attache changed nothing.`);
  return parsed as Record<string, unknown>;
}

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
  const plugin = () => join(openCodeConfigDir(), "plugins", `${id()}.js`);
  const expected = () => openCodePluginText(hooks.stateDir, id());

  /** The plugin file's text when it is this instance's, null when absent; throws when another file is in its place. */
  function current(): string | null {
    const path = plugin();
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    if (instanceOf(text) !== hooks.stateDir) throw new HooksFileError(`${path} exists and was not written by this Attache; Attache will not change it. Move it away, then connect again.`);
    return text;
  }

  /** Throws, naming the file, when OpenCode's configuration would turn off or replace this instance's registration. */
  function checkOpenCodeSetup() {
    checkOpenCodeVersion(agentHome());
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

  function plan(): HarnessFileChange[] {
    checkOpenCodeSetup();
    const text = current();
    if (text === expected()) return [];
    return [{ path: plugin(), change: text === null ? "create" : "update", backup: text !== null, purpose: PURPOSE }];
  }

  const restartRequired = true;
  const adapter: HarnessAdapter = {
    kind: "opencode",
    label: "OpenCode",
    capabilities: { mcp: true, memory: "none", capture: "none" },
    restartRequired,
    manualSetup: true,
    setupNote:
      "Attache adds one plugin to OpenCode's global plugins folder that registers Attache's MCP server each time OpenCode loads it; your opencode.json(c), MCP servers and other plugins are not changed. Works with OpenCode 1 (1.18.29 or later) and OpenCode 2. Restart OpenCode after connecting (for OpenCode 2's background service, run opencode service restart). If OpenCode was not found, you can still connect: Attache uses ~/.config/opencode, or XDG_CONFIG_HOME or OPENCODE_CONFIG_DIR when the Attache service has them set.",
    detect: (home) => openCodeFound(home),
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
      const path = plugin();
      try {
        checkOpenCodeSetup();
        const text = current();
        if (text === null) return { state: "missing", message: `Attache's OpenCode plugin is not in ${path}. Set up again to fix it.`, files: [] };
        if (text !== expected()) return { state: "stale", message: `Attache's OpenCode plugin ${path} is out of date. Set up again to fix it.`, files: [path] };
        return { state: "current", message: `Attache's OpenCode plugin ${path}, which registers Attache's MCP server each time OpenCode loads it`, files: [path] };
      } catch (e) {
        return { state: "failed", message: (e as Error).message, files: [] };
      }
    },
    refresh: () => adapter.apply(),
    uninstall: () => {
      const path = plugin();
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
