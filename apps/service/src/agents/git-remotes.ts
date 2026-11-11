import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The remote addresses of the git repository a folder belongs to, read from
 * the repository's own config file. Imported by the session-start hook, so it
 * runs no `git` process and touches no network: it walks up to the nearest
 * `.git`, follows a worktree's or submodule's `gitdir:` pointer and its
 * `commondir`, and parses the `[remote "…"]` sections. `origin` comes first.
 * A folder outside any repository, or one whose config cannot be read, has
 * no remotes.
 */
export function gitRemoteUrls(folder: string): string[] {
  try {
    const gitDir = findGitDir(resolve(folder));
    if (!gitDir) return [];
    const config = join(commonDir(gitDir), "config");
    return existsSync(config) ? parseRemoteUrls(readFileSync(config, "utf8")) : [];
  } catch {
    return [];
  }
}

function findGitDir(start: string): string | null {
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, ".git");
    if (existsSync(candidate)) {
      if (statSync(candidate).isDirectory()) return candidate;
      const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(candidate, "utf8"));
      return pointer ? resolve(dir, pointer[1]!) : null;
    }
    if (dirname(dir) === dir) return null;
  }
}

/** A linked worktree keeps its config in the main repository's git folder, named by `commondir`. */
function commonDir(gitDir: string): string {
  const file = join(gitDir, "commondir");
  return existsSync(file) ? resolve(gitDir, readFileSync(file, "utf8").trim()) : gitDir;
}

const SECTION_RE = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/;
const ENTRY_RE = /^([A-Za-z][A-Za-z0-9-]*)\s*=\s*(.*)$/;

/** Remote URLs in a git config file, `origin` first, then in file order. */
export function parseRemoteUrls(config: string): string[] {
  const found: Array<{ remote: string; url: string }> = [];
  let remote: string | null = null;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    const section = SECTION_RE.exec(line);
    if (section) {
      remote = section[1]!.toLowerCase() === "remote" && section[2] !== undefined ? section[2] : null;
      continue;
    }
    const entry = remote === null ? null : ENTRY_RE.exec(line);
    if (entry && entry[1]!.toLowerCase() === "url") found.push({ remote: remote!, url: configValue(entry[2]!) });
  }
  const ordered = [...found.filter((f) => f.remote === "origin"), ...found.filter((f) => f.remote !== "origin")];
  return ordered.map((f) => f.url).filter(Boolean);
}

/** A config value without its quotes or trailing comment. */
function configValue(value: string): string {
  const quoted = /^"((?:[^"\\]|\\.)*)"/.exec(value);
  if (quoted) return quoted[1]!.replace(/\\(.)/g, "$1");
  return value.replace(/\s[#;].*$/, "").trim();
}
