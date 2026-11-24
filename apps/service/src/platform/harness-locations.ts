import { delimiter } from "node:path";
import { pathFor, toolCandidates, type PlatformLocations } from "./locations.ts";
import type { Os } from "./os.ts";

export type HarnessKind = "claude-code" | "codex" | "antigravity" | "claude-desktop";

/**
 * Where a Harness keeps the files Attache edits for its hooks, relative to the
 * home folder. Harnesses use the same layout under the home folder on every
 * operating system, so these are constants.
 */
export interface HarnessFiles {
  /** The hooks file Attache adds its hooks to; null for a Harness without hooks. */
  hooksFile: string | null;
  /** Folder of always-loaded rule files, for a Harness without a session-start hook. */
  rulesDir: string | null;
  /**
   * User-level skills folder, where versions before the MCP prompts installed
   * the save and audit skills. Only read to remove those skills on upgrade.
   */
  legacySkillsDir: string | null;
}

export const HARNESS_FILES: Readonly<Record<HarnessKind, HarnessFiles>> = {
  "claude-code": { hooksFile: ".claude/settings.json", rulesDir: null, legacySkillsDir: ".claude/skills" },
  codex: { hooksFile: ".codex/hooks.json", rulesDir: null, legacySkillsDir: ".agents/skills" },
  antigravity: { hooksFile: ".gemini/config/hooks.json", rulesDir: ".gemini/config/rules", legacySkillsDir: ".gemini/config/skills" },
  "claude-desktop": { hooksFile: null, rulesDir: null, legacySkillsDir: null },
};

/** Where a Harness lists its MCP servers: a file relative to the home folder, and its format. */
export interface HarnessMcpConfig {
  file: string;
  format: "json" | "toml";
}

/** Claude Desktop keeps its settings in the operating system's application data folder. */
const CLAUDE_DESKTOP_DIR: Readonly<Record<Os, string>> = {
  macos: "Library/Application Support/Claude",
  windows: "AppData/Roaming/Claude",
  linux: ".config/Claude",
};

/**
 * Where each Harness lists its MCP servers on an operating system. Claude
 * Code's user-level servers live in `~/.claude.json`, not in its settings file.
 */
export function harnessMcpConfigs(os: Os): Readonly<Record<HarnessKind, HarnessMcpConfig>> {
  return {
    "claude-code": { file: ".claude.json", format: "json" },
    codex: { file: ".codex/config.toml", format: "toml" },
    antigravity: { file: ".gemini/config/mcp_config.json", format: "json" },
    "claude-desktop": { file: `${CLAUDE_DESKTOP_DIR[os]}/claude_desktop_config.json`, format: "json" },
  };
}

/** Where a Harness is installed on this operating system, as absolute paths. */
export interface HarnessInstall {
  /** Its command-line executable, in the order Attache prefers them. */
  executables: string[];
  /** Any of these existing means the Harness is installed. */
  presence: string[];
}

/** Desktop application folders, which differ per operating system. */
function appFolders(loc: PlatformLocations, app: string): string[] {
  if (loc.os === "macos") return [`/Applications/${app}.app`];
  if (loc.os === "windows") return [pathFor("windows").join(loc.home, "AppData", "Local", "Programs", app)];
  return [`/usr/share/${app.toLowerCase()}`, `/opt/${app}`];
}

/** Where the Claude Desktop app installs; there is no official Linux build, so only its settings folder tells. */
function claudeDesktopApp(loc: PlatformLocations): string[] {
  if (loc.os === "macos") return ["/Applications/Claude.app"];
  if (loc.os === "windows") return [pathFor("windows").join(loc.home, "AppData", "Local", "AnthropicClaude")];
  return [];
}

/**
 * The locations to look for Harness executables in: only the folders
 * `ATTACHE_HARNESS_TOOL_DIRS` lists (separated as in PATH) when it is set,
 * so tests and the e2e stack never find the Machine's own Harnesses.
 */
function harnessLookup(loc: PlatformLocations): PlatformLocations {
  const only = process.env.ATTACHE_HARNESS_TOOL_DIRS;
  return only === undefined ? loc : { ...loc, toolDirs: only.split(delimiter).filter(Boolean) };
}

/**
 * Where each Harness is installed. Pass the locations for the home folder
 * whose Harness settings Attache edits (`locationsForHome`), which tests point
 * at a temporary folder.
 */
export function harnessInstalls(location: PlatformLocations): Record<HarnessKind, HarnessInstall> {
  const loc = harnessLookup(location);
  const { join } = pathFor(loc.os);
  const at = (relative: string) => join(loc.home, ...relative.split("/"));
  const [firstToolDir, ...otherToolDirs] = loc.toolDirs;
  const toolsIn = (dirs: string[], name: string) => toolCandidates({ ...loc, toolDirs: dirs }, name);
  // The Claude Code native installer's own copy comes right after the first tool folder, as it always has.
  const claude = [...toolsIn(firstToolDir ? [firstToolDir] : [], "claude"), at(".claude/local/claude"), ...toolsIn(otherToolDirs, "claude")];
  const tools = (name: string) => toolCandidates(loc, name);
  return {
    "claude-code": { executables: claude, presence: [at(".claude"), ...claude] },
    codex: { executables: tools("codex"), presence: [at(".codex"), ...tools("codex")] },
    antigravity: { executables: tools("agy"), presence: [...appFolders(loc, "Antigravity"), ...tools("agy"), at(".gemini/antigravity"), at(".gemini/antigravity-cli")] },
    // The desktop app has no command line; its settings folder appears on first launch.
    "claude-desktop": { executables: [], presence: [...claudeDesktopApp(loc), at(CLAUDE_DESKTOP_DIR[loc.os])] },
  };
}

/**
 * Pi keeps its global settings, `mcp.json` and auto-discovered extensions in
 * one agent folder under the home folder on every operating system, unless
 * `PI_CODING_AGENT_DIR` points elsewhere.
 */
export const PI_AGENT_DIR = ".pi/agent";

/**
 * Where Pi may be installed. Pi is usually an npm global package, whose
 * folder Attache cannot always know (a Node version manager, a custom
 * prefix), so not finding it here is uncertain rather than final.
 */
export function piInstall(location: PlatformLocations): HarnessInstall {
  const loc = harnessLookup(location);
  const { join } = pathFor(loc.os);
  const executables = toolCandidates(loc, "pi");
  return { executables, presence: [join(loc.home, ".pi"), ...executables] };
}

/**
 * OpenCode's global config folder, relative to the home folder:
 * `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`, on every operating
 * system (OpenCode 1 and 2 both use XDG paths, also on macOS).
 */
export const OPENCODE_CONFIG_DIR = ".config/opencode";

/**
 * Where OpenCode may be installed: its curl installer's `~/.opencode/bin`,
 * then the usual tool folders. OpenCode is often an npm global package or a
 * Homebrew formula whose folder Attache cannot always know, so not finding it
 * here is uncertain rather than final.
 */
export function openCodeInstall(location: PlatformLocations): HarnessInstall {
  const loc = harnessLookup(location);
  const { join } = pathFor(loc.os);
  const installer = executableNamesIn(loc, join(loc.home, ".opencode", "bin"), "opencode");
  const executables = [...installer, ...toolCandidates(loc, "opencode")];
  // The config folder is not a sign: other tools write plugins there without OpenCode being installed.
  return { executables, presence: [join(loc.home, ".opencode"), ...executables] };
}

const executableNamesIn = (loc: PlatformLocations, dir: string, name: string) => toolCandidates({ ...loc, toolDirs: [dir] }, name);

/**
 * Copilot CLI's home folder, relative to the home folder, on every operating
 * system unless `COPILOT_HOME` points elsewhere. It is not a sign that Copilot
 * CLI is installed: the GitHub Copilot app and SDK-hosted runtimes share it.
 */
export const COPILOT_HOME_DIR = ".copilot";

/**
 * Copilot CLI's home folder: `COPILOT_HOME` when it is an absolute path,
 * otherwise `~/.copilot`. Connecting and the hooks use this one rule, so they
 * always agree on where Copilot CLI's files are.
 */
export function copilotHomeFor(home: string, env: NodeJS.ProcessEnv, os: Os): string {
  const path = pathFor(os);
  const dir = env.COPILOT_HOME?.trim();
  return dir && path.isAbsolute(dir) ? dir : path.join(home, COPILOT_HOME_DIR);
}

/**
 * Where Copilot CLI may be installed: the usual tool folders (its install
 * script uses `~/.local/bin` or `/usr/local/bin`, Homebrew its own), and the
 * folder `gh copilot` downloads it to. It is often an npm global package or a
 * WinGet install whose folder Attache cannot always know, so not finding it
 * here is uncertain rather than final.
 */
export function copilotCliInstall(location: PlatformLocations): HarnessInstall {
  const loc = harnessLookup(location);
  const { join } = pathFor(loc.os);
  const executables = toolCandidates(loc, "copilot");
  return { executables, presence: [...executables, join(loc.home, ".local", "share", "gh", "copilot")] };
}
