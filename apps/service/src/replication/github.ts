import { isAbsolute } from "node:path";

/** A repository on GitHub, as Replication names it. */
export interface GitHubRepo {
  readonly owner: string;
  readonly name: string;
  /** How git reaches it: https uses the GitHub connection's token, ssh the Machine's own keys. */
  readonly transport: "https" | "ssh";
}

/** What Replication borrows from the GitHub connection. */
export interface GitHubAccess {
  /** The GitHub connection, if one is set up: its id and the API it talks to. */
  connection(): { id: string; apiBase: string } | null;
  /** The connection's token, read from the secret store. */
  token(connectionId: string): Promise<string | null>;
}

const NAME = "([A-Za-z0-9-]{1,39})/([A-Za-z0-9._-]{1,100}?)(?:\\.git)?/?";
const HTTPS = new RegExp(`^https://github\\.com/${NAME}$`, "i");
const SSH_URL = new RegExp(`^ssh://git@github\\.com(?::22)?/${NAME}$`, "i");
const SCP_LIKE = new RegExp(`^git@github\\.com:${NAME}$`, "i");
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

/** The GitHub repository a remote address points at, or null when it is not on GitHub. */
export function githubRepoOf(remote: string): GitHubRepo | null {
  const https = HTTPS.exec(remote);
  if (https) return Object.freeze({ owner: https[1]!, name: https[2]!, transport: "https" });
  const ssh = SSH_URL.exec(remote) ?? SCP_LIKE.exec(remote);
  if (ssh) return Object.freeze({ owner: ssh[1]!, name: ssh[2]!, transport: "ssh" });
  return null;
}

/** A remote that is a folder on this Machine or a disk it mounts: nobody else can read it through the network. */
export function isFolderRemote(remote: string): boolean {
  return isAbsolute(remote) || WINDOWS_PATH.test(remote) || remote.startsWith("file:");
}

/** No GitHub connection: GitHub remotes are checked without a token, and https ones cannot authenticate. */
export const NO_GITHUB: GitHubAccess = Object.freeze({ connection: () => null, token: async () => null });
