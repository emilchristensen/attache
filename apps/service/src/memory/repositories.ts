/**
 * The repositories a project note lists, in its `Repositories` fact.
 *
 * A repository is written the way the owner knows it: `owner/name` (GitHub),
 * `host/owner/name`, or any remote address (`git@host:owner/name.git`,
 * `https://host/owner/name`, `ssh://git@host/owner/name`). Every form reduces
 * to one key, `host/owner/name` in lower case, so the SSH and HTTPS remotes of
 * one repository match the same project. Imported by the session-start hook:
 * no dependencies.
 */

/** Current-state subjects that list a project's repositories, compared case-insensitively. */
export const REPOSITORY_SUBJECTS = ["repositories", "repository"] as const;

/** Hosting service assumed for the `owner/name` shorthand. */
const DEFAULT_HOST = "github.com";

const URL_RE = /^(?:ssh|git|https?|git\+ssh|ssh\+git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d*)?\/(.+)$/i;
const SCP_RE = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/;
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
/** Characters a repository is often wrapped in when written in prose or Markdown. */
const WRAPPING = /^[`'"<(\[]+|[`'">)\].]+$/g;

export const isRepositorySubject = (subject: string): boolean => (REPOSITORY_SUBJECTS as readonly string[]).includes(subject.trim().toLowerCase());

/** The `host/owner/name` key of a repository reference or remote address, or null when it is not one. */
export function repositoryKey(ref: string): string | null {
  const text = ref.trim().replace(WRAPPING, "");
  if (!text || /\s/.test(text)) return null;
  const url = URL_RE.exec(text);
  if (url) return key(url[1]!, url[2]!);
  if (!text.includes("://")) {
    const scp = SCP_RE.exec(text);
    if (scp) return key(scp[1]!, scp[2]!);
  }
  if (text.includes(":")) return null;
  const parts = text.split("/");
  return parts[0]!.includes(".") ? key(parts[0]!, parts.slice(1).join("/")) : key(DEFAULT_HOST, text);
}

function key(host: string, path: string): string | null {
  const segments = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").split("/");
  if (!HOST_RE.test(host) || segments.length < 2) return null;
  if (!segments.every((s) => SEGMENT_RE.test(s) && s !== "." && s !== "..")) return null;
  return `${host}/${segments.join("/")}`.toLowerCase();
}

/** Split a `Repositories` value (commas, semicolons or white space between entries) into keys and entries that are not repositories. */
export function parseRepositoryList(value: string): { keys: string[]; invalid: string[] } {
  const entries = value.split(/[\s,;]+/).filter((e) => e.replace(WRAPPING, ""));
  const keys: string[] = [];
  const invalid: string[] = [];
  for (const entry of entries) {
    const k = repositoryKey(entry);
    if (!k) invalid.push(entry);
    else if (!keys.includes(k)) keys.push(k);
  }
  return { keys, invalid };
}

/** The repository keys a note's current facts list; entries that are not repositories are ignored. */
export function listedRepositories(facts: ReadonlyArray<{ subject: string; value: string }>): string[] {
  const keys = facts.filter((f) => isRepositorySubject(f.subject)).flatMap((f) => parseRepositoryList(f.value).keys);
  return [...new Set(keys)];
}
