import { pathFor, toolCandidates, type PlatformLocations } from "./locations.ts";

export type HarnessKind = "claude-code" | "codex" | "antigravity";

/**
 * Where a Harness keeps the files Jarvis edits, relative to the home folder.
 * Harnesses use the same layout under the home folder on every operating
 * system, so these are constants.
 */
export interface HarnessFiles {
  /** The hooks file Jarvis adds its hooks to. */
  hooksFile: string;
  /** Folder of always-loaded rule files, for a Harness without a session-start hook. */
  rulesDir: string | null;
  /** User-level skills folder. */
  skillsDir: string;
}

export const HARNESS_FILES: Readonly<Record<HarnessKind, HarnessFiles>> = {
  "claude-code": { hooksFile: ".claude/settings.json", rulesDir: null, skillsDir: ".claude/skills" },
  codex: { hooksFile: ".codex/hooks.json", rulesDir: null, skillsDir: ".agents/skills" },
  antigravity: { hooksFile: ".gemini/config/hooks.json", rulesDir: ".gemini/config/rules", skillsDir: ".gemini/config/skills" },
};

/** Where a Harness is installed on this operating system, as absolute paths. */
export interface HarnessInstall {
  /** Its command-line executable, in the order Jarvis prefers them. */
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

/**
 * Where each Harness is installed. Pass the locations for the home folder
 * whose Harness settings Jarvis edits (`locationsForHome`), which tests point
 * at a temporary folder.
 */
export function harnessInstalls(loc: PlatformLocations): Record<HarnessKind, HarnessInstall> {
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
  };
}
