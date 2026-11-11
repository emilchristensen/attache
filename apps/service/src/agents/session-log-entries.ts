import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitFrontmatter } from "../memory/markdown.ts";
import { sessionLogDate } from "../memory/evidence-paths.ts";
import { parseRepositoryList } from "../memory/repositories.ts";

/**
 * Entries of the session logs in `evidence/sessions/`. Each Machine writes
 * its own file per day; an entry is one `## HH:MM · Harness · folder`
 * section. An entry written in a git repository carries a
 * `Repository: <key>[, <key>]` line, which is how a project's session
 * context finds the sessions that ran in its repositories.
 */
const REPOSITORY_LINE = /^Repository: (.+)$/m;

export interface SessionLogEntry {
  /** The day the log speaks for, `YYYY-MM-DD`. */
  date: string;
  /** The entry's heading without `## `, e.g. `08:30 · Claude Code · orion`. */
  heading: string;
  /** The entry's text without its heading and its Repository line. */
  body: string;
  /** Repository keys the session ran in; empty for a session outside a repository and for entries written before this line existed. */
  repositories: string[];
}

/** The line a session-log entry carries for the repository its session ran in; none outside a repository. */
export function repositoryLine(keys: readonly string[]): string | null {
  return keys.length ? `Repository: ${keys.join(", ")}` : null;
}

/** The entries of one session-log file's body (frontmatter and `# ` title already removed). */
export function parseSessionLog(date: string, body: string): SessionLogEntry[] {
  return body
    .split(/^## /m)
    .slice(1)
    .map((chunk) => {
      const [heading = "", ...rest] = chunk.split("\n");
      const text = rest.join("\n");
      const repositories = parseRepositoryList(REPOSITORY_LINE.exec(text)?.[1] ?? "").keys;
      return { date, heading: heading.trim(), body: text.replace(REPOSITORY_LINE, "").replace(/\n{3,}/g, "\n\n").trim(), repositories };
    });
}

/** Every entry of the session logs of the latest `days` days that have one, every Machine's file read, newest first. */
export function recentSessionLogEntries(dir: string, days: number): SessionLogEntry[] {
  if (!existsSync(dir)) return [];
  const byDate = new Map<string, string[]>();
  for (const f of readdirSync(dir)) {
    const date = sessionLogDate(f);
    if (date) byDate.set(date, [...(byDate.get(date) ?? []), f]);
  }
  const dates = [...byDate.keys()].sort().reverse().slice(0, days);
  const entries = dates.flatMap((date) => byDate.get(date)!.flatMap((f) => parseSessionLog(date, readBody(join(dir, f)))));
  return entries.sort((a, b) => b.date.localeCompare(a.date) || b.heading.localeCompare(a.heading));
}

function readBody(file: string): string {
  try {
    return splitFrontmatter(readFileSync(file, "utf8")).body.replace(/^# .*\n/, "");
  } catch {
    return "";
  }
}
