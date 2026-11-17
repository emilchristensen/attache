import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_FILES } from "../platform/harness-locations.ts";

/** The file earlier versions put in every skill folder they installed. */
const MARKER = ".attache-skill.json";

/** Whether a skill folder carries the marker of the Attache install at `stateDir`. */
function markedForInstall(folder: string, stateDir: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(folder, MARKER), "utf8")) as { managedBy?: unknown; stateDir?: unknown };
    return marker.managedBy === "attache" && marker.stateDir === stateDir;
  } catch {
    return false;
  }
}

/**
 * Remove the save and audit skills that versions before the MCP prompts
 * installed in each Harness's skills folder. Only folders whose marker names
 * this install go; a folder without the marker, or another install's, stays.
 * Idempotent, so it runs on every start.
 */
export function removeLegacySkills(home: string, stateDir: string): { removed: string[]; errors: Array<{ folder: string; error: string }> } {
  const dirs = [...new Set(Object.values(HARNESS_FILES).flatMap((f) => (f.legacySkillsDir ? [join(home, ...f.legacySkillsDir.split("/"))] : [])).filter((d) => existsSync(d)).map((d) => realpathSync(d)))];
  const removed: string[] = [];
  const errors: Array<{ folder: string; error: string }> = [];
  const list = (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      errors.push({ folder: dir, error: (e as Error).message });
      return [];
    }
  };
  for (const dir of dirs) {
    for (const entry of list(dir)) {
      const folder = join(dir, entry.name);
      if (!entry.isDirectory() || !markedForInstall(folder, stateDir)) continue;
      try {
        rmSync(folder, { recursive: true, force: true });
        removed.push(folder);
      } catch (e) {
        errors.push({ folder, error: (e as Error).message });
      }
    }
  }
  return { removed, errors };
}
