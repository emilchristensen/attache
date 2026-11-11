import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { repositoryKey } from "../memory/repositories.ts";
import { gitRemoteUrls } from "./git-remotes.ts";
import { agentsDir, contextFile } from "./spool.ts";
import { replaceWith } from "../platform/replace-file.ts";

/**
 * The session context files the service writes and the session-start hook
 * picks from, in the state folder:
 *
 *   agents/session-context.md            the global context
 *   agents/projects/<slug>.md            one context per project that lists repositories
 *   agents/projects/repositories.json    repository key → project file, written last
 *
 * The hook reads the folder's git remotes from disk and prints the matching
 * project's file, or the global one. Imported by the hook: no heavy deps.
 */
export const projectContextDir = (stateDir: string) => join(agentsDir(stateDir), "projects");
const repositoryIndexFile = (stateDir: string) => join(projectContextDir(stateDir), "repositories.json");

const PROJECT_FILE_RE = /^[a-z0-9][a-z0-9-]*\.md$/;

export interface ProjectContext {
  /** File name stem, unique per project note. */
  slug: string;
  /** Repository keys (`host/owner/name`) the project lists. */
  repositories: string[];
  text: string;
}

interface RepositoryIndex {
  v: 1;
  repositories: Record<string, string>;
}

/** The slug of a project note's context file, from its path in the Brain. */
export function projectSlug(relPath: string): string {
  return (
    relPath
      .replace(/^memory\/projects\//, "")
      .replace(/\.md$/, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

/**
 * Write the global and per-project files, then the repository index, then
 * remove project files nothing points to. Each file is replaced atomically,
 * so a hook running meanwhile reads either the old or the new text.
 * A repository listed by two projects goes to the first one given.
 */
export function writeContextFiles(stateDir: string, global: string, projects: readonly ProjectContext[]): void {
  writeIfChanged(contextFile(stateDir), global);
  const dir = projectContextDir(stateDir);
  const index: RepositoryIndex = { v: 1, repositories: {} };
  const files = new Set<string>();
  for (const p of projects) {
    const name = `${p.slug}.md`;
    if (!PROJECT_FILE_RE.test(name) || files.has(name)) continue;
    const claimed = p.repositories.filter((r) => !(r in index.repositories));
    if (!claimed.length) continue;
    writeIfChanged(join(dir, name), p.text);
    files.add(name);
    for (const r of claimed) index.repositories[r] = name;
  }
  writeIfChanged(repositoryIndexFile(stateDir), JSON.stringify(index, null, 2) + "\n");
  for (const f of readdirSync(dir)) if (f.endsWith(".md") && !files.has(f)) rmSync(join(dir, f), { force: true });
}

/** Remove every context file, while session context is off. */
export function removeContextFiles(stateDir: string): void {
  rmSync(contextFile(stateDir), { force: true });
  rmSync(projectContextDir(stateDir), { recursive: true, force: true });
}

/** The context file for a session started in `folder`: its project's when a git remote matches one, otherwise the global file. */
export function contextFileFor(stateDir: string, folder: string | null): string {
  const global = contextFile(stateDir);
  if (!folder) return global;
  const index = readIndex(stateDir);
  if (!index) return global;
  for (const url of gitRemoteUrls(folder)) {
    const key = repositoryKey(url);
    const name = key ? index.repositories[key] : undefined;
    if (!name || !PROJECT_FILE_RE.test(name)) continue;
    const file = join(projectContextDir(stateDir), name);
    if (existsSync(file)) return file;
  }
  return global;
}

function readIndex(stateDir: string): RepositoryIndex | null {
  try {
    const parsed = JSON.parse(readFileSync(repositoryIndexFile(stateDir), "utf8")) as Partial<RepositoryIndex>;
    return parsed?.v === 1 && parsed.repositories && typeof parsed.repositories === "object" ? (parsed as RepositoryIndex) : null;
  } catch {
    return null;
  }
}

function writeIfChanged(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (existsSync(file) && readFileSync(file, "utf8") === text) return;
  const tmp = join(dirname(file), `.${randomUUID()}.tmp`);
  writeFileSync(tmp, text, { mode: 0o600 });
  replaceWith(tmp, file);
}
