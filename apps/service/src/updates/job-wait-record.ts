/**
 * When an Update began to wait for Jobs (spec #130, "Updater"): `<state>/updates/job-wait.json` `{ version, since }`,
 * kept outside the database like the Updater's other records, so a restart does not start the 24 hours again and a
 * Machine that is restarted often while always busy still installs. Forgotten once the Update installs; a newer Update
 * that waits replaces it, and its 24 hours start then.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { writeFileWhole } from "../platform/replace-file.ts";
import { updatesDir } from "./bad-versions.ts";

const JobWaitRecord = z.object({ version: z.string(), since: z.string() });
type JobWaitRecord = z.infer<typeof JobWaitRecord>;

const recordFile = (stateDir: string) => join(updatesDir(stateDir), "job-wait.json");

function read(stateDir: string): JobWaitRecord | null {
  const file = recordFile(stateDir);
  if (!existsSync(file)) return null;
  const parsed = JobWaitRecord.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success || Number.isNaN(Date.parse(parsed.data.since))) throw new Error(`${file} is not a record of an Update waiting for Jobs: ${parsed.error?.issues[0]?.message ?? "unreadable time"}.`);
  return parsed.data;
}

/** When the Update to `version` began to wait for Jobs: the time recorded for it, or `now`, recorded now. */
export function jobWaitSince(stateDir: string, version: string, now: Date): Date {
  const known = read(stateDir);
  if (known?.version === version) return new Date(known.since);
  mkdirSync(updatesDir(stateDir), { recursive: true, mode: 0o700 });
  writeFileWhole(recordFile(stateDir), JSON.stringify({ version, since: now.toISOString() }, null, 2) + "\n", { mode: 0o600 });
  return now;
}

/** The Update installs: no wait is left to remember. */
export const forgetJobWait = (stateDir: string): void => rmSync(recordFile(stateDir), { force: true });
