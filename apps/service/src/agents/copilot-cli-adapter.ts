import { existsSync, readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute, join } from "node:path";
import type { HarnessFileChange, HarnessStatusReport } from "@attache/contracts";
import { COPILOT_HOME_DIR, copilotCliInstall } from "../platform/harness-locations.ts";
import { locationsForHome } from "../platform/locations.ts";
import { HooksFileError, writeConfigText } from "./hooks-config.ts";
import { agentHome, mcpServerEntry, type AgentHooks } from "./install.ts";
import type { HarnessAdapter } from "./harness-adapters.ts";
import { parseJsonc } from "./jsonc.ts";
import { jsonMcpConfig } from "./mcp-config-json.ts";
import { isPlainObject } from "./mcp-config-format.ts";

/**
 * Copilot CLI through its personal MCP configuration (ADR 0006).
 *
 * Attache adds one entry per instance to `mcp-config.json` in Copilot CLI's
 * home folder, the file `copilot mcp add` writes, and changes nothing else in
 * it: no repository is touched. Copilot CLI reads the file as JSON with
 * comments; Attache writes it back as plain JSON, as `copilot mcp add` does,
 * after backing it up. `settings.json` is only read, to refuse a setup in
 * which the owner has turned this server off.
 */

const PURPOSE = "Attache's MCP server in Copilot CLI's personal MCP configuration";
const PURPOSE_COMMENTS = `${PURPOSE}; the file is written back as plain JSON, as copilot mcp add does, so its comments are kept only in the backup`;

/** Copilot CLI's home folder: `COPILOT_HOME` when it names one, else `~/.copilot`. */
export function copilotHome(): string {
  const dir = process.env.COPILOT_HOME?.trim();
  if (dir && isAbsolute(dir)) return dir;
  return join(agentHome(), COPILOT_HOME_DIR);
}

/** Whether Copilot CLI looks installed: one of its executables, or the folder `gh copilot` downloads it to. */
export function copilotCliFound(home: string): boolean {
  return copilotCliInstall(locationsForHome(home)).presence.some((p) => existsSync(p));
}

/** A file of Copilot CLI's (JSON with comments) as an object, or undefined when absent or empty; throws, naming the file, when it does not parse. */
function readCopilotJson(path: string): { raw: string; value: Record<string, unknown> } | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = parseJsonc(raw.replace(/^﻿/, ""));
  } catch (e) {
    throw new HooksFileError(`${path} is not valid JSON (${(e as Error).message}); fix it so Copilot CLI can read it, then connect again. Attache changed nothing.`);
  }
  if (!isPlainObject(parsed)) throw new HooksFileError(`${path} does not contain a JSON object; fix it, then connect again. Attache changed nothing.`);
  return { raw, value: parsed };
}

/** Whether a text is plain JSON, with no comments or trailing commas to lose when Attache writes it back. */
function plainJson(raw: string): boolean {
  try {
    JSON.parse(raw.replace(/^﻿/, ""));
    return true;
  } catch {
    return false;
  }
}

export function copilotCliAdapter(hooks: AgentHooks): HarnessAdapter {
  const name = () => hooks.ownerKey();
  const configPath = () => join(copilotHome(), "mcp-config.json");
  const settingsPath = () => join(copilotHome(), "settings.json");
  const entry = () => ({ type: "local", ...mcpServerEntry(hooks.stateDir), tools: ["*"] });
  const isOurs = hooks.mcp.isOurs;

  /** The configuration as plain JSON text ("" when absent), with the raw text it came from. Throws on a file Attache must not change. */
  function config(): { raw: string; json: string } {
    const read = readCopilotJson(configPath());
    return { raw: read?.raw ?? "", json: read ? JSON.stringify(read.value) : "" };
  }

  /** Throws, naming the file, when Copilot CLI's settings turn this instance's server off. */
  function checkSettings() {
    const settings = readCopilotJson(settingsPath())?.value;
    const disabled = settings?.disabledMcpServers;
    if (Array.isArray(disabled) && disabled.includes(name())) {
      throw new HooksFileError(`${settingsPath()} turns off the MCP server "${name()}" (disabledMcpServers), so Copilot CLI would not start it. Run copilot mcp enable ${name()}, then connect again. Attache changed nothing.`);
    }
  }

  /** This instance's entries in the configuration, by name. */
  function ours(json: string): Array<[string, unknown]> {
    return Object.entries(jsonMcpConfig.servers(json, configPath())).filter(([, e]) => isOurs(e));
  }

  const isCurrent = (json: string) => {
    const mine = ours(json);
    return mine.length === 1 && mine[0]![0] === name() && isDeepStrictEqual(mine[0]![1], entry());
  };

  /** The change connecting makes, worked out before anything is written. */
  function plan(): { changes: HarnessFileChange[]; after: string } {
    checkSettings();
    const { raw, json } = config();
    if (isCurrent(json)) return { changes: [], after: raw };
    const after = jsonMcpConfig.withServer(json, configPath(), name(), entry(), isOurs);
    const exists = existsSync(configPath());
    const purpose = exists && raw.trim() && !plainJson(raw) ? PURPOSE_COMMENTS : PURPOSE;
    return { changes: [{ path: configPath(), change: exists ? "update" : "create", backup: exists, purpose }], after };
  }

  const restartRequired = true;
  const adapter: HarnessAdapter = {
    kind: "copilot-cli",
    label: "Copilot CLI",
    capabilities: { mcp: true, memory: "none", capture: "none" },
    restartRequired,
    manualSetup: true,
    setupNote:
      "Attache adds its MCP server to Copilot CLI's personal MCP configuration (mcp-config.json in ~/.copilot, or in COPILOT_HOME when the Attache service has it set); your other MCP servers and settings are not changed, and no repository is touched. Start a new copilot session after connecting, or run /mcp reload in a running one. A repository's own .mcp.json can replace a server of the same name for sessions in that repository. If Copilot CLI was not found, you can still connect.",
    detect: (home) => copilotCliFound(home),
    preview: () => ({ changes: plan().changes, restartRequired }),
    apply: () => {
      const { changes, after } = plan();
      const backups: string[] = [];
      for (const c of changes) {
        const { backup } = writeConfigText(c.path, after, hooks.backupDir);
        if (backup) backups.push(backup);
      }
      return { changes, backups, restartRequired };
    },
    status: (): HarnessStatusReport => {
      const path = configPath();
      try {
        checkSettings();
        const { json } = config();
        if (isCurrent(json)) return { state: "current", message: `Attache's MCP server in ${path}`, files: [path] };
        if (ours(json).length) return { state: "stale", message: `Attache's MCP server in ${path} is out of date. Set up again to fix it.`, files: [path] };
        return { state: "missing", message: `Attache's MCP server is not in ${path}. Set up again to fix it.`, files: [] };
      } catch (e) {
        return { state: "failed", message: (e as Error).message, files: [] };
      }
    },
    refresh: () => adapter.apply(),
    uninstall: () => {
      const path = configPath();
      try {
        const { json } = config();
        if (!ours(json).length) return { removed: [], failures: [] };
        writeConfigText(path, jsonMcpConfig.withoutServers(json, path, isOurs), hooks.backupDir);
        return { removed: [{ path, change: "update", backup: true, purpose: PURPOSE }], failures: [] };
      } catch (e) {
        return { removed: [], failures: [`Could not remove Attache's MCP server from ${path}: ${(e as Error).message}`] };
      }
    },
  };
  return adapter;
}
