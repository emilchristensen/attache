/**
 * Versions that failed on this Machine: the installer switched back after
 * them, so the Updater never tries them again, while a newer release still is
 * (spec #130, user story 18). Kept in the Machine's state, not in the
 * database, which a rollback restores to before the attempt.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileWhole } from "../platform/replace-file.ts";

const BadVersion = z.object({ version: z.string(), reason: z.string(), at: z.string() });
const BadVersionsFile = z.object({ versions: z.array(BadVersion) });
export type BadVersion = z.infer<typeof BadVersion>;

/** `<state>/updates`: everything the Updater keeps on this Machine. */
export const updatesDir = (stateDir: string): string => join(stateDir, "updates");
const badVersionsFile = (stateDir: string) => join(updatesDir(stateDir), "bad-versions.json");

/** Every version marked bad on this Machine, oldest mark first. */
export function badVersions(stateDir: string): BadVersion[] {
  const file = badVersionsFile(stateDir);
  if (!existsSync(file)) return [];
  const parsed = BadVersionsFile.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new Error(`${file} is not a list of versions that failed on this Machine: ${parsed.error.issues[0]?.message ?? "unreadable"}.`);
  return parsed.data.versions;
}

/** Never try `version` again on this Machine. Marking a version twice keeps the first reason. */
export function markVersionBad(stateDir: string, mark: { version: string; reason: string; at: Date }): void {
  const known = badVersions(stateDir);
  if (known.some((b) => b.version === mark.version)) return;
  mkdirSync(updatesDir(stateDir), { recursive: true, mode: 0o700 });
  const versions = [...known, { version: mark.version, reason: mark.reason, at: mark.at.toISOString() }];
  writeFileWhole(badVersionsFile(stateDir), JSON.stringify({ versions }, null, 2) + "\n", { mode: 0o600 });
}
