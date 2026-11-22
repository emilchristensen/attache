import { existsSync, readFileSync, rmSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute, join } from "node:path";
import type { HarnessApplyResult, HarnessFileChange, HarnessStatusReport } from "@attache/contracts";
import { COPILOT_HOME_DIR, copilotCliInstall } from "../platform/harness-locations.ts";
import { locationsForHome } from "../platform/locations.ts";
import { shellPath } from "../platform/shell-command.ts";
import { HooksFileError, replaceFile, writeConfigText } from "./hooks-config.ts";
import { readHarnessJson } from "./harness-json.ts";
import { agentHome, hookScript, mcpServerEntry, stablePath, type AgentHooks } from "./install.ts";
import { checkCopilotCliVersion } from "./copilot-cli-version.ts";
import type { HarnessAdapter } from "./harness-adapters.ts";
import { parseJsonc } from "./jsonc.ts";
import { COPILOT_HOOK_EVENTS } from "./hook-profiles.ts";
import type { HookEvent } from "./spool.ts";
import { jsonMcpConfig } from "./mcp-config-json.ts";
import { isPlainObject } from "./mcp-config-format.ts";

/**
 * Copilot CLI through its personal MCP configuration and personal hooks (ADR 0006).
 *
 * Attache adds one entry per instance to `mcp-config.json` in Copilot CLI's
 * home folder, the file `copilot mcp add` writes, and changes nothing else in
 * it: no repository is touched. Copilot CLI reads the file as JSON with
 * comments; Attache writes it back as plain JSON, as `copilot mcp add` does,
 * after backing it up.
 *
 * Memory and session capture come from one personal hooks file per
 * instance, `hooks/<instance>.json`: a `sessionStart` command hook that runs
 * Attache's hook script, which prints the current memory as
 * `additionalContext`, so every new, cleared (`/clear`) or resumed session
 * starts with today's memory; and `agentStop`, `preCompact` and `sessionEnd`
 * hooks that copy the session's `events.jsonl` into the spool
 * (agents/copilot-cli-transcript.ts reads it). Copilot CLI combines every file in that folder, so the owner's own
 * hooks files and other instances' files are never opened. No instruction
 * file is written.
 *
 * `settings.json` is only read, to refuse a setup in which the owner has
 * turned this server, or all hooks, off.
 */

const PURPOSE = "Attache's MCP server in Copilot CLI's personal MCP configuration";
const HOOKS_PURPOSE = "Attache's personal Copilot CLI hooks that give each new, cleared or resumed session your current Attache memory and save the conversation after each turn, before compaction and when the session ends";
/** Copilot CLI waits 30 seconds for a hook by default; Attache's read or copy a file, waiting at most 3 seconds for Copilot CLI to write it. */
const HOOK_TIMEOUT_SEC = 10;
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
const readCopilotJson = (path: string) => readHarnessJson(path, "Copilot CLI", parseJsonc);

/** A path quoted for PowerShell, which Copilot CLI uses for hooks on Windows. */
const powershellPath = (p: string) => `'${p.replace(/'/g, "''")}'`;

/**
 * This instance's personal hooks file: `sessionStart`, `agentStop`,
 * `preCompact` and `sessionEnd` command hooks (COPILOT_HOOK_EVENTS) running
 * Attache's hook script for Copilot CLI, each with a `bash` command (macOS, Linux,
 * and Windows with Git Bash) and a `powershell` one, the fields Copilot CLI's
 * hooks reference documents for command hooks.
 */
export function copilotHooksText(stateDir: string, hook: string, node: string = process.execPath): string {
  const entry = (event: HookEvent) => {
    const args = ["copilot-cli", event, "--state-dir"];
    const bash = `${shellPath(node)} ${shellPath(hook)} ${args.join(" ")} ${shellPath(stateDir)}`;
    const powershell = `& ${powershellPath(node)} ${powershellPath(hook)} ${args.join(" ")} ${powershellPath(stateDir)}`;
    return [{ type: "command", bash, powershell, timeoutSec: HOOK_TIMEOUT_SEC }];
  };
  const hooks = Object.fromEntries(Object.entries(COPILOT_HOOK_EVENTS).map(([hookType, event]) => [hookType, entry(event)]));
  return `${JSON.stringify({ version: 1, hooks }, null, 2)}\n`;
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
  const hooksPath = () => join(copilotHome(), "hooks", `${name()}.json`);
  const expectedHooks = () => copilotHooksText(hooks.stateDir, stablePath(hookScript()), stablePath(process.execPath));

  /** The hooks file's text when it is this instance's, null when absent; throws when another file is in its place. */
  function currentHooks(): string | null {
    const path = hooksPath();
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    if (!hooksFileIsOurs(text)) throw new HooksFileError(`${path} exists and was not written by this Attache; Attache will not change it. Move it away, then connect again.`);
    return text;
  }

  /** A hooks file is this instance's when one of its hook commands runs Attache's hook script for this state folder. */
  function hooksFileIsOurs(text: string): boolean {
    try {
      const file = JSON.parse(text) as { hooks?: Record<string, unknown> };
      const entries = Object.values(file?.hooks ?? {}).flatMap((list) => (Array.isArray(list) ? list : []));
      return entries.some((e) => isPlainObject(e) && typeof e.bash === "string" && hooks.isOurs(e.bash));
    } catch {
      return false;
    }
  }

  /** The configuration as plain JSON text ("" when absent), with the raw text it came from. Throws on a file Attache must not change. */
  function config(): { raw: string; json: string } {
    const read = readCopilotJson(configPath());
    return { raw: read?.raw ?? "", json: read ? JSON.stringify(read.value) : "" };
  }

  /** Throws, naming the file, when the installed Copilot CLI is too old or its settings turn this instance's server, or all hooks, off. */
  function checkSettings(wait: boolean) {
    checkCopilotCliVersion(agentHome(), { wait });
    const settings = readCopilotJson(settingsPath())?.value;
    const disabled = settings?.disabledMcpServers;
    if (Array.isArray(disabled) && disabled.includes(name())) {
      throw new HooksFileError(`${settingsPath()} turns off the MCP server "${name()}" (disabledMcpServers), so Copilot CLI would not start it. Run copilot mcp enable ${name()}, then connect again. Attache changed nothing.`);
    }
    if (settings?.disableAllHooks === true) {
      throw new HooksFileError(`${settingsPath()} turns off all hooks (disableAllHooks), so Copilot CLI would not run the hooks that give its sessions your Attache memory and save them. Remove that setting, then connect again. Attache changed nothing.`);
    }
  }

  /** This instance's entries in the configuration, by name. */
  function ours(json: string): Array<[string, unknown]> {
    return Object.entries(jsonMcpConfig.servers(json, configPath())).filter(([, e]) => isOurs(e));
  }

  const isCurrent = (json: string) => {
    const mine = ours(json);
    // Fields Copilot CLI adds on its own (its `type`, an empty `env` or `headers`) do not count; the command and the tools Attache offers do.
    return mine.length === 1 && mine[0]![0] === name() && hooks.mcp.sameCommand(mine[0]![1]) && isDeepStrictEqual((mine[0]![1] as { tools?: unknown }).tools, entry().tools);
  };

  /** The changes connecting makes, each with the text it writes, worked out before anything is written. */
  function plan(wait: boolean): Array<HarnessFileChange & { text: string }> {
    checkSettings(wait);
    const { raw, json } = config();
    const hooksText = currentHooks();
    const changes: Array<HarnessFileChange & { text: string }> = [];
    if (!isCurrent(json)) {
      const exists = existsSync(configPath());
      const purpose = exists && raw.trim() && !plainJson(raw) ? PURPOSE_COMMENTS : PURPOSE;
      changes.push({ path: configPath(), change: exists ? "update" : "create", backup: exists, purpose, text: jsonMcpConfig.withServer(json, configPath(), name(), entry(), isOurs) });
    }
    if (hooksText !== expectedHooks()) changes.push({ path: hooksPath(), change: hooksText === null ? "create" : "update", backup: hooksText !== null, purpose: HOOKS_PURPOSE, text: expectedHooks() });
    return changes;
  }
  const withoutText = ({ text: _text, ...c }: HarnessFileChange & { text: string }): HarnessFileChange => c;

  function write(changes: Array<HarnessFileChange & { text: string }>): HarnessApplyResult {
    const backups: string[] = [];
    for (const c of changes) {
      if (c.change === "create") replaceFile(c.path, c.text);
      else {
        const { backup } = writeConfigText(c.path, c.text, hooks.backupDir);
        if (backup) backups.push(backup);
      }
    }
    return { changes: changes.map(withoutText), backups, restartRequired };
  }

  const restartRequired = true;
  const adapter: HarnessAdapter = {
    kind: "copilot-cli",
    label: "Copilot CLI",
    capabilities: { mcp: true, memory: "runtime-fresh", capture: "with-final-event" },
    restartRequired,
    manualSetup: true,
    setupNote:
      "Attache adds its MCP server to Copilot CLI's personal MCP configuration (mcp-config.json in ~/.copilot, or in COPILOT_HOME when the Attache service has it set) and one personal hooks file (hooks/attache.json there): its session-start hook gives each new, cleared or resumed session your current Attache memory, and its agentStop, preCompact and sessionEnd hooks save the conversation (your words and Copilot CLI's answers, never tool output or subagents) from the session's events.jsonl after each turn, before compaction and when the session ends; only a Copilot CLI that is killed or crashes mid-turn can lose that newest turn. Your other MCP servers, hooks and settings are not changed, and no repository is touched. Memory and saving need the Agent sessions feature on and Copilot CLI 1.0.22 or later. Copilot CLI reads hooks when it starts, so start a new copilot process after connecting. A session keeps the memory it started with: after /compact it has none until you /clear, resume or start a new one. A repository whose .github/copilot/settings.json sets disableAllHooks turns Attache's hooks off for sessions there, and a repository's own .mcp.json can replace a server of the same name. If Copilot CLI was not found, you can still connect.",
    detect: (home) => copilotCliFound(home),
    preview: () => ({ changes: plan(true).map(withoutText), restartRequired }),
    apply: () => write(plan(true)),
    status: (): HarnessStatusReport => {
      const path = configPath();
      const hooksFile = hooksPath();
      try {
        checkSettings(false);
        const { json } = config();
        const hooksText = currentHooks();
        const mcp = isCurrent(json) ? "current" : ours(json).length ? "stale" : "missing";
        const memory = hooksText === expectedHooks() ? "current" : hooksText === null ? "missing" : "stale";
        const files = [...(mcp === "missing" ? [] : [path]), ...(memory === "missing" ? [] : [hooksFile])];
        if (mcp === "current" && memory === "current") return { state: "current", message: `Attache's MCP server in ${path}, and its hooks in ${hooksFile}`, files };
        if (mcp === "missing" && memory === "missing") return { state: "missing", message: `Attache's MCP server is not in ${path}, and its hooks file ${hooksFile} is missing. Set up again to fix it.`, files };
        const problems = [
          ...(mcp === "stale" ? [`Attache's MCP server in ${path} is out of date`] : mcp === "missing" ? [`Attache's MCP server is not in ${path}`] : []),
          ...(memory === "stale" ? [`Attache's hooks file ${hooksFile} is out of date`] : memory === "missing" ? [`Attache's hooks file ${hooksFile} is missing`] : []),
        ];
        return { state: "stale", message: `${problems.join("; ")}. Set up again to fix it.`, files };
      } catch (e) {
        return { state: "failed", message: (e as Error).message, files: [] };
      }
    },
    // The version was checked when the owner connected; a refresh (on every start) never waits for Copilot CLI.
    refresh: () => write(plan(false)),
    uninstall: () => {
      const removed: HarnessFileChange[] = [];
      const failures: string[] = [];
      const path = configPath();
      try {
        const { json } = config();
        if (ours(json).length) {
          writeConfigText(path, jsonMcpConfig.withoutServers(json, path, isOurs), hooks.backupDir);
          removed.push({ path, change: "update", backup: true, purpose: PURPOSE });
        }
      } catch (e) {
        failures.push(`Could not remove Attache's MCP server from ${path}: ${(e as Error).message}`);
      }
      const hooksFile = hooksPath();
      try {
        // Another file in its place is the owner's: it stays.
        if (existsSync(hooksFile) && hooksFileIsOurs(readFileSync(hooksFile, "utf8"))) {
          rmSync(hooksFile);
          removed.push({ path: hooksFile, change: "remove", backup: false, purpose: HOOKS_PURPOSE });
        }
      } catch (e) {
        failures.push(`Could not remove Attache's hooks file ${hooksFile}: ${(e as Error).message}`);
      }
      return { removed, failures };
    },
  };
  return adapter;
}
