import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { classifyFailure, Git, GitError } from "./git.ts";
import { BRANCH, REMOTE } from "./brain-repo.ts";
import type { Logger } from "../core/log.ts";
import { normalizeRemote, RemoteError } from "./remote.ts";
import type { RemoteVerdict, ReplicationSeams } from "./seams.ts";
import { toLf } from "../memory/markdown.ts";

/** A setup or join the owner has to change something for; `status` and `code` are the API's. */
export class ReplicationSetupError extends Error {
  readonly status: number;
  readonly code: string;
  /** Machine-readable facts for the API, e.g. where a refused folder was backed up. */
  readonly details: Readonly<Record<string, unknown>> | undefined;
  constructor(status: number, code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Files that are this Machine's alone: Jarvis's own bookkeeping, half-written
 * temporary files and the folder state editors keep per computer.
 */
export const IGNORED = [".jarvis/", ".*.tmp", ".DS_Store", "Thumbs.db", ".obsidian/workspace*.json"];

/**
 * Notes are text with LF line endings on every Machine, Windows included:
 * git stores a note an editor saved with CRLF as LF, and checks every note
 * out as LF, whatever `core.autocrlf` says.
 */
export const LF_ATTRIBUTE = "* text=auto eol=lf";

/**
 * Pin the Brain to LF. The line goes first, as the default: an owner's own
 * attributes for some files (say, `*.png binary`) come after it and still apply.
 */
function pinLineEndings(file: string): void {
  const existing = existsSync(file) ? toLf(readFileSync(file, "utf8")) : "";
  if (existing.split("\n").some((l) => l.trim() === LF_ATTRIBUTE)) return;
  writeFileSync(file, `${LF_ATTRIBUTE}\n${existing}`);
}

/** Marks a repository as one Jarvis made, so setup can be finished after it was interrupted. */
const MANAGED_KEY = "jarvis.managed";

/** The remote the owner typed, normalised, or why it is not one. */
export function setupRemote(input: string): string {
  try {
    return normalizeRemote(input);
  } catch (e) {
    if (e instanceof RemoteError) throw new ReplicationSetupError(400, "invalid_remote", e.message);
    throw e;
  }
}

/** Why setup or join cannot use a remote the guards refused; null when they let it through. */
export function refusalOf(v: RemoteVerdict): ReplicationSetupError | null {
  if (v.ok) return null;
  if (v.status === "offline") return new ReplicationSetupError(502, "remote_unreachable", v.cause);
  if (v.status === "unauthorized") return new ReplicationSetupError(502, "remote_unauthorized", v.cause);
  return new ReplicationSetupError(409, "remote_refused", v.cause);
}

/**
 * A folder that is not empty may hold a Brain of its own. Two Brains are never
 * merged, so the join is refused; the folder is backed up first, so the owner
 * can move it aside and still keep what it held.
 */
export async function notEmptyRefusal(target: string, backUp: (folder: string) => Promise<string>, log: Logger): Promise<ReplicationSetupError> {
  const refusal = `${target} is not empty. Jarvis joins a Brain only into an empty folder, so two Brains are never merged.`;
  try {
    const backup = await backUp(target);
    return new ReplicationSetupError(409, "not_empty", `${refusal} It was backed up to ${backup}. Move the folder aside or choose an empty one, then join again.`, { backup });
  } catch (e) {
    log.error("could not back up a folder a join refused", { folder: target, error: (e as Error).message });
    return new ReplicationSetupError(409, "not_empty", `${refusal} Backing it up failed too (${(e as Error).message}); nothing in it was changed.`);
  }
}

/** Turn a remote failure into what the owner sees when setting up or joining. */
export function remoteFailure(e: unknown, action: string): ReplicationSetupError {
  if (!(e instanceof GitError)) return new ReplicationSetupError(500, "replication_failed", `Could not ${action}: ${(e as Error).message}`);
  if (e.kind === "offline") return new ReplicationSetupError(502, "remote_unreachable", `Could not reach the repository to ${action} (${e.cause}). Check the network and the address, then try again.`);
  if (e.kind === "unauthorized") return new ReplicationSetupError(502, "remote_unauthorized", `The repository refused this Machine (${e.cause}). Check that git on this Machine can reach it.`);
  return new ReplicationSetupError(502, "replication_failed", `Could not ${action}: ${e.cause}`);
}

function ensureLines(file: string, lines: readonly string[]): void {
  const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
  const have = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = lines.filter((l) => !have.has(l));
  if (!missing.length) return;
  writeFileSync(file, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}

/** Whether `git.cwd` is a repository Jarvis made, i.e. Replication ran here before. */
export function isManagedRepository(git: Git): boolean {
  return existsSync(join(git.cwd, ".git")) && git.runSync(["config", "--get", MANAGED_KEY]).stdout.trim() === "true";
}

/**
 * Whether the Brain in `remote` grew from the same history as this Machine's
 * copy, as it does when Replication was switched off here and is set up again.
 * Fetches into a scratch ref, so neither `origin` nor its tracking branch moves.
 */
export async function sharesHistoryWith(git: Git, remote: string, seams: ReplicationSeams): Promise<boolean> {
  if (!isManagedRepository(git) || git.runSync(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).code !== 0) return false;
  const scratch = "refs/jarvis/candidate";
  try {
    await git.with(seams.credentials.env(remote)).ok([...seams.credentials.config(remote).flatMap((c) => ["-c", c]), "fetch", "--quiet", "--no-tags", remote, `+refs/heads/${BRANCH}:${scratch}`]);
  } catch (e) {
    throw remoteFailure(e, "check the repository");
  }
  try {
    return git.runSync(["merge-base", "HEAD", scratch]).code === 0;
  } finally {
    git.runSync(["update-ref", "-d", scratch]);
  }
}

/**
 * Make the data folder a repository Jarvis manages, pointed at `remote`.
 * A repository Jarvis did not make is refused: its branches and settings are
 * the owner's, and Replication would rewrite neither safely.
 */
export function prepareRepository(git: Git, remote: string): void {
  const root = git.cwd;
  if (existsSync(join(root, ".git"))) {
    if (!isManagedRepository(git)) {
      throw new ReplicationSetupError(409, "already_a_repository", `${root} is already a git repository that Jarvis did not make. Replication needs a data folder that is not under git yet.`);
    }
  } else {
    git.okSync(["init", "-q", "-b", BRANCH]);
  }
  git.okSync(["config", MANAGED_KEY, "true"]);
  ensureLines(join(root, ".gitignore"), IGNORED);
  pinLineEndings(join(root, ".gitattributes"));
  const remotes = git.okSync(["remote"]).split("\n").map((r) => r.trim());
  git.okSync(remotes.includes(REMOTE) ? ["remote", "set-url", REMOTE, remote] : ["remote", "add", REMOTE, remote]);
}

/** Whether the remote already holds a Brain (its main branch has commits). */
export async function remoteHasBrain(git: Git, remote: string, seams: ReplicationSeams): Promise<boolean> {
  const args = [...seams.credentials.config(remote).flatMap((c) => ["-c", c]), "ls-remote", "--heads", remote, `refs/heads/${BRANCH}`];
  try {
    return (await git.with(seams.credentials.env(remote)).ok(args)).trim().length > 0;
  } catch (e) {
    throw remoteFailure(e, "check the repository");
  }
}

/** Empty, or missing: the only folders a Machine may join into. */
export function isEmptyFolder(path: string): boolean {
  return !existsSync(path) || readdirSync(path).every((f) => f === ".DS_Store");
}

/** Clone the Brain into `target`, which must be empty. Leaves nothing behind when it fails. */
export async function cloneBrain(remote: string, target: string, seams: ReplicationSeams): Promise<void> {
  const created = !existsSync(target);
  mkdirSync(dirname(target), { recursive: true });
  const git = new Git({ cwd: dirname(target) }).with(seams.credentials.env(remote));
  const r = await git.run([...seams.credentials.config(remote).flatMap((c) => ["-c", c]), "clone", "-q", "--origin", REMOTE, "--branch", BRANCH, remote, target]).catch((e: unknown) => {
    throw remoteFailure(e, "clone the Brain");
  });
  if (r.code !== 0) {
    if (created) rmSync(target, { recursive: true, force: true });
    else for (const f of readdirSync(target)) rmSync(join(target, f), { recursive: true, force: true });
    if (/Remote branch \S+ not found|empty repository/i.test(r.stderr)) throw new ReplicationSetupError(409, "remote_empty", "That repository holds no Brain yet. Set Replication up on the Machine that has the Brain first.");
    throw remoteFailure(new GitError(classifyFailure(r.stderr), "clone", r.stderr), "clone the Brain");
  }
  new Git({ cwd: target }).okSync(["config", MANAGED_KEY, "true"]);
}
