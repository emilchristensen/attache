import type { Clock } from "./clock.ts";
import { githubRepoOf, isFolderRemote, type GitHubAccess, type GitHubRepo } from "./github.ts";
import type { RemoteGuard, RemoteVerdict } from "./seams.ts";

/**
 * How long a repository confirmed private is trusted before GitHub is asked
 * again. Checks run before every push and at least once a minute; this keeps
 * them well inside GitHub's rate limit, also without a token.
 */
export const VISIBILITY_CHECK_EVERY_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export interface PrivateRemoteGuardDeps {
  github: GitHubAccess;
  clock: Pick<Clock, "now">;
  fetch?: typeof fetch;
}

const OK: RemoteVerdict = Object.freeze({ ok: true });

const reconnect = "Reconnect GitHub in the Jarvis Dashboard with a token that can read and write this repository.";

/**
 * Replication goes only to a repository nobody else can read: a private
 * GitHub repository, or a folder. GitHub is asked at setup, at join and,
 * once the answer is a few minutes old, before the next push; a repository
 * that turned public blocks pushing until it is private again.
 */
export class PrivateRemoteGuard implements RemoteGuard {
  readonly name = "private repository";
  private readonly deps: PrivateRemoteGuardDeps;
  /** When each remote was last confirmed private. Only a private answer is kept. */
  private readonly confirmed = new Map<string, number>();

  constructor(deps: PrivateRemoteGuardDeps) {
    this.deps = deps;
  }

  async check(remote: string): Promise<RemoteVerdict> {
    if (isFolderRemote(remote)) return OK;
    const repo = githubRepoOf(remote);
    if (!repo) {
      return { ok: false, status: "blocked", cause: `Jarvis can confirm that a repository is private only on GitHub, so it does not replicate to ${remote}. Use a private GitHub repository.` };
    }
    const now = this.deps.clock.now().getTime();
    const at = this.confirmed.get(remote);
    if (at !== undefined && now - at < VISIBILITY_CHECK_EVERY_MS && now >= at) return OK;
    this.confirmed.delete(remote);
    const verdict = await this.ask(repo);
    if (verdict.ok) this.confirmed.set(remote, now);
    return verdict;
  }

  private async ask(repo: GitHubRepo, withToken = true): Promise<RemoteVerdict> {
    const full = `${repo.owner}/${repo.name}`;
    const connection = this.deps.github.connection();
    const token = connection && withToken ? await this.deps.github.token(connection.id) : null;
    if (repo.transport === "https" && !token) {
      return { ok: false, status: "unauthorized", cause: `Replication reaches ${full} with the token of the GitHub connection, and GitHub is not connected. ${reconnect}` };
    }
    const apiBase = (connection?.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    let res: Response;
    try {
      res = await (this.deps.fetch ?? fetch)(`${apiBase}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`, {
        headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, status: "offline", cause: `Could not reach GitHub to check that ${full} is private.` };
    }
    if (res.status === 401) {
      // Over ssh git uses the Machine's own keys, so a stale GitHub connection only means asking without it.
      if (repo.transport === "ssh" && token) return this.ask(repo, false);
      return { ok: false, status: "unauthorized", cause: `GitHub rejected the token of the GitHub connection. ${reconnect}` };
    }
    // Without a token GitHub answers 404 for a private repository: a public one is always visible.
    if (res.status === 404) return token ? { ok: false, status: "unauthorized", cause: `The GitHub connection cannot see ${full}. Check the repository's name. ${reconnect}` } : OK;
    if (!res.ok) return { ok: false, status: "offline", cause: `GitHub did not say whether ${full} is private (HTTP ${res.status}). Jarvis asks again shortly.` };
    const body = (await res.json().catch(() => null)) as { private?: unknown; visibility?: unknown } | null;
    if (body?.private === true || body?.visibility === "private" || body?.visibility === "internal") return OK;
    if (body?.private === false || body?.visibility === "public") {
      return { ok: false, status: "blocked", cause: `${full} is public on GitHub. Jarvis replicates the Brain only to a private repository: make ${full} private, then check Replication again.` };
    }
    return { ok: false, status: "offline", cause: `GitHub did not say whether ${full} is private. Jarvis asks again shortly.` };
  }
}
