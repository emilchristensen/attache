import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { classifyFailure, Git, GitError } from "./git.ts";
import { BRANCH, REMOTE } from "./brain-repo.ts";
import type { ReplicationSeams } from "./seams.ts";

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

/** Notes are text with LF line endings on every Machine, Windows included. */
export const ATTRIBUTES = "* text=auto eol=lf\n";

/** Marks a repository as one Jarvis made, so setup can be finished after it was interrupted. */
const MANAGED_KEY = "jarvis.managed";

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

/**
 * Make the data folder a repository Jarvis manages, pointed at `remote`.
 * A repository Jarvis did not make is refused: its branches and settings are
 * the owner's, and Replication would rewrite neither safely.
 */
export function prepareRepository(git: Git, remote: string): void {
  const root = git.cwd;
  if (existsSync(join(root, ".git"))) {
    if (git.runSync(["config", "--get", MANAGED_KEY]).stdout.trim() !== "true") {
      throw new ReplicationSetupError(409, "already_a_repository", `${root} is already a git repository that Jarvis did not make. Replication needs a data folder that is not under git yet.`);
    }
  } else {
    git.okSync(["init", "-q", "-b", BRANCH]);
  }
  git.okSync(["config", MANAGED_KEY, "true"]);
  ensureLines(join(root, ".gitignore"), IGNORED);
  if (!existsSync(join(root, ".gitattributes"))) writeFileSync(join(root, ".gitattributes"), ATTRIBUTES);
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
