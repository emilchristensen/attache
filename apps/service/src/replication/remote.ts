import { isAbsolute } from "node:path";

export class RemoteError extends Error {}

const GITHUB_SHORT = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;
const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/;
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/;

/**
 * The repository the owner named, as a git remote address. `owner/name` means
 * that repository on GitHub. A token or password is never accepted inside the
 * address: it would end up in git's configuration in plain text.
 */
export function normalizeRemote(input: string): string {
  const value = input.trim();
  if (!value) throw new RemoteError("Name the repository, for example owner/attache-brain.");
  if (/\p{Cc}/u.test(value) || value.startsWith("-")) throw new RemoteError("A repository address cannot start with a dash or hold control characters.");
  // A folder may have spaces in its name, as owners' folders often do; an address may not.
  if (isAbsolute(value) || WINDOWS_PATH.test(value)) return value;
  if (/\s/.test(value)) throw new RemoteError("A repository address cannot hold spaces.");
  const short = GITHUB_SHORT.exec(value);
  if (short) return `https://github.com/${short[1]}/${short[2]!.replace(/\.git$/, "")}.git`;
  if (SCP_LIKE.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RemoteError(`${value} is not a repository address. Use owner/name for GitHub, an https:// or ssh:// address, or a folder path.`);
  }
  if (!["https:", "ssh:", "file:"].includes(url.protocol)) throw new RemoteError(`Replication uses https://, ssh:// or a folder, not ${url.protocol}`);
  if (url.password || (url.protocol === "https:" && url.username)) throw new RemoteError("Leave the token out of the repository address. Attache keeps it in the secret store.");
  if (url.search || url.hash) throw new RemoteError("A repository address has no ? or # part.");
  return value;
}
