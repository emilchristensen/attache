import { cliScript, stablePath } from "../agents/install.ts";
import { posixShellWord } from "../platform/shell-command.ts";
import { githubRepoOf, type GitHubAccess } from "./github.ts";
import type { GitCredentials } from "./seams.ts";

/** The `attache` subcommand git runs as its credential helper. */
export const CREDENTIAL_HELPER_COMMAND = "git-credential";
/** The user name GitHub expects alongside a token. */
export const TOKEN_USERNAME = "x-access-token";

/**
 * This install's `attache`: the bundled runtime and service through the stable `current` path, or `attache` on PATH.
 * Quoted for the POSIX shell git runs helpers with, on Windows too (Git for Windows brings its own).
 */
function attacheCommand(): string {
  const script = cliScript();
  return script ? `${posixShellWord(stablePath(process.execPath))} ${posixShellWord(stablePath(script))}` : "attache";
}

/**
 * Git reaches a GitHub repository over https with the GitHub connection's
 * token. Git asks Attache's credential helper, which reads the token from the
 * secret store at that moment, so the token is never part of the remote
 * address, the repository's configuration, a command line or the logs.
 * The Machine's own credential helpers are switched off for these commands,
 * so a rejected token shows as a rejected token. Other remotes use the
 * Machine's own setup (ssh keys, or nothing for a folder).
 */
export function githubCredentials(deps: { github: GitHubAccess; stateDir: string; instance: string }): GitCredentials {
  return {
    config(remote) {
      if (githubRepoOf(remote)?.transport !== "https") return [];
      const connection = deps.github.connection();
      // An empty helper first drops every helper the Machine's git config lists.
      if (!connection) return ["credential.helper="];
      return ["credential.helper=", `credential.helper=!${attacheCommand()} ${CREDENTIAL_HELPER_COMMAND} --state-dir ${posixShellWord(deps.stateDir)} --connection ${posixShellWord(connection.id)}`];
    },
    env(remote): Readonly<Record<string, string>> {
      return githubRepoOf(remote)?.transport === "https" ? { ATTACHE_INSTANCE: deps.instance } : {};
    },
  };
}

/** What git asks a credential helper: `protocol`, `host`, `path`, ... one `key=value` per line. */
export function parseCredentialRequest(input: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const line of input.split(/\r?\n/)) {
    if (!line) break;
    const eq = line.indexOf("=");
    if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return Object.freeze(out);
}

/**
 * The helper's answer. Only `get` is answered, and only over http(s): git's
 * `store` and `erase` are ignored, because the token belongs to the GitHub
 * connection and only the owner replaces it, by reconnecting GitHub.
 */
export function credentialAnswer(action: string, request: Readonly<Record<string, string>>, token: string | null): string {
  if (action !== "get" || !token) return "";
  if (request.protocol !== "https" && request.protocol !== "http") return "";
  if (/[\r\n\0]/.test(token)) return "";
  return `username=${TOKEN_USERNAME}\npassword=${token}\n`;
}
