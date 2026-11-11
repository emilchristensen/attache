import { Git, GitError } from "./git.ts";
import { JARVIS_REFS_FETCH, REMOTE } from "./brain-repo.ts";
import type { GitCredentials } from "./seams.ts";
import { LeaseRecord } from "../reader/lease.ts";

/**
 * Where the Reader lease lives: a ref of its own in the Brain's repository,
 * `refs/jarvis/reader`, never a branch. Each renewal is a small commit with an
 * empty tree whose message holds the lease, made on top of the last one, so
 * the ref only ever moves forward: a push is the compare-and-swap, and a
 * rejected push means another Machine wrote the lease first. The heartbeat
 * never adds a commit to the Brain's history, never touches the data folder,
 * and is not cloned with the Brain.
 */
export const LEASE_REF = "refs/jarvis/reader";
/** This Machine's copy of the remote's lease, refreshed by every fetch (`JARVIS_REFS_FETCH`). */
export const LEASE_TRACKING = `refs/remotes/${REMOTE}/jarvis/reader`;

const SUBJECT = "Jarvis Reader lease";

export interface StoredLease {
  /** The commit holding it, which the next renewal builds on. */
  tip: string;
  /** Null when the commit does not hold a lease Jarvis can read; the next renewal replaces it. */
  record: LeaseRecord | null;
}

export function encodeLease(record: LeaseRecord): string {
  return `${SUBJECT}: ${record.name}\n\n${JSON.stringify(record)}\n`;
}

export function decodeLease(message: string): LeaseRecord | null {
  const body = message.slice(message.indexOf("\n\n") + 2).trim();
  try {
    const parsed = LeaseRecord.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The lease as this Machine last fetched or wrote it, in one copy of the Brain's repository. */
export class LeaseRef {
  private readonly git: Git;
  private readonly credentials: GitCredentials;

  constructor(git: Git, credentials: GitCredentials) {
    this.git = git;
    this.credentials = credentials;
  }

  read(): StoredLease | null {
    const tip = this.git.runSync(["rev-parse", "--verify", "--quiet", `${LEASE_TRACKING}^{commit}`]);
    if (tip.code !== 0) return null;
    const sha = tip.stdout.trim();
    return { tip: sha, record: decodeLease(this.git.okSync(["log", "-1", "--format=%B", sha])) };
  }

  /** Fetch the remote's lease alone, after another Machine wrote it first. */
  async fetch(remote: string): Promise<void> {
    await this.remoteGit(remote).ok([...this.credentialArgs(remote), "fetch", "--quiet", "--no-tags", REMOTE, JARVIS_REFS_FETCH]);
  }

  /**
   * Write `record` on top of `parent` and push it. Returns false when another
   * Machine moved the lease first; fetch and decide again then.
   */
  async write(remote: string, record: LeaseRecord, parent: string | null, author: Record<string, string>): Promise<boolean> {
    const tree = this.git.okSync(["mktree"], "").trim();
    const sha = this.git
      .with(author)
      .okSync(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-F", "-"], encodeLease(record))
      .trim();
    try {
      await this.remoteGit(remote).ok([...this.credentialArgs(remote), "push", "--quiet", REMOTE, `${sha}:${LEASE_REF}`]);
    } catch (e) {
      if (e instanceof GitError && e.kind === "rejected") return false;
      throw e;
    }
    this.git.okSync(["update-ref", LEASE_TRACKING, sha]);
    return true;
  }

  private remoteGit(remote: string): Git {
    return this.git.with(this.credentials.env(remote));
  }

  private credentialArgs(remote: string): string[] {
    return this.credentials.config(remote).flatMap((c) => ["-c", c]);
  }
}
