import { Git, GitError, READER_LEASE_REFS } from "./git.ts";
import { JARVIS_REFS_FETCH, REMOTE } from "./brain-repo.ts";
import type { GitCredentials } from "./seams.ts";
import { LeaseRecord } from "../reader/lease.ts";

/**
 * Where the Reader lease lives: refs of its own in the Brain's repository,
 * `refs/jarvis/reader-lease/<generation>`, never a branch. Each renewal is a
 * small commit with an empty tree whose message holds the lease, made on top
 * of the last one, so a generation's ref only ever moves forward: a push is
 * the compare-and-swap, and a rejected push means another Machine wrote the
 * lease first. The heartbeat never adds a commit to the Brain's history, never
 * touches the data folder, and is not cloned with the Brain.
 *
 * A ref that only moves forward keeps every commit it ever held, so after
 * `LEASE_GENERATION_COMMITS` renewals the lease moves to a new generation, in
 * one atomic push: the current generation gets a last commit that says so
 * (a forward move like any renewal, so it still loses to a concurrent write),
 * the next generation starts with a commit of its own, and the generation
 * before the current one, which nobody writes any more, is deleted. At most
 * two generations exist, so the lease's history stays bounded.
 */
export const LEASE_GENERATION_COMMITS = 144;
/** This Machine's copies of the remote's lease generations, refreshed by every fetch (`JARVIS_REFS_FETCH`). */
const TRACKING = `refs/remotes/${REMOTE}/${READER_LEASE_REFS.slice("refs/".length)}`;

const SUBJECT = "Jarvis Reader lease";

export interface StoredLease {
  /** The newest generation, the one that holds the lease. */
  generation: number;
  /** The commit holding it, which the next renewal builds on. */
  tip: string;
  /** Null when the commit does not hold a lease Jarvis can read; the next renewal replaces it. */
  record: LeaseRecord | null;
}

export function encodeLease(record: LeaseRecord): string {
  return `${SUBJECT}: ${record.name}\n\n${JSON.stringify(record)}\n`;
}

export function decodeLease(message: string): LeaseRecord | null {
  const split = message.indexOf("\n\n");
  if (split < 0) return null;
  try {
    const parsed = LeaseRecord.safeParse(JSON.parse(message.slice(split + 2).trim()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const leaseRef = (generation: number) => `${READER_LEASE_REFS}/${generation}`;
const trackingRef = (generation: number) => `${TRACKING}/${generation}`;

interface Generation {
  generation: number;
  tip: string;
}

/** The lease as this Machine last fetched or wrote it, in one copy of the Brain's repository. */
export class LeaseRef {
  private readonly git: Git;
  private readonly credentials: GitCredentials;
  private readonly generationCommits: number;

  constructor(git: Git, credentials: GitCredentials, generationCommits = LEASE_GENERATION_COMMITS) {
    this.git = git;
    this.credentials = credentials;
    this.generationCommits = Math.max(1, generationCommits);
  }

  read(): StoredLease | null {
    const current = this.generations().at(-1);
    if (!current) return null;
    return { ...current, record: decodeLease(this.git.okSync(["log", "-1", "--format=%B", current.tip])) };
  }

  /** Fetch the remote's lease alone, after another Machine wrote it first. */
  async fetch(remote: string): Promise<void> {
    await this.remoteGit(remote).ok([...this.credentialArgs(remote), "fetch", "--quiet", "--no-tags", "--prune", REMOTE, JARVIS_REFS_FETCH]);
  }

  /**
   * Write `record` after `current`, the lease as last read, and push it.
   * Returns false when another Machine moved the lease first; fetch and
   * decide again then.
   */
  async write(remote: string, record: LeaseRecord, current: StoredLease | null, author: Record<string, string>): Promise<boolean> {
    const updates = this.updates(record, current, author);
    const refspecs = updates.map((u) => `${u.sha ?? ""}:${leaseRef(u.generation)}`);
    try {
      await this.remoteGit(remote).ok([...this.credentialArgs(remote), "push", "--quiet", ...(refspecs.length > 1 ? ["--atomic"] : []), REMOTE, ...refspecs]);
    } catch (e) {
      if (e instanceof GitError && e.kind === "rejected") return false;
      throw e;
    }
    for (const u of updates) this.git.okSync(u.sha ? ["update-ref", trackingRef(u.generation), u.sha] : ["update-ref", "-d", trackingRef(u.generation)]);
    return true;
  }

  /** What one write changes on the remote: a renewal, or a move to the next generation. A null `sha` deletes. */
  private updates(record: LeaseRecord, current: StoredLease | null, author: Record<string, string>): Array<{ generation: number; sha: string | null }> {
    if (!current) return [{ generation: 1, sha: this.commit(encodeLease(record), null, author) }];
    const length = Number(this.git.okSync(["rev-list", "--count", current.tip]).trim());
    if (length < this.generationCommits) return [{ generation: current.generation, sha: this.commit(encodeLease(record), current.tip, author) }];
    const next = current.generation + 1;
    const retired = this.generations().filter((g) => g.generation < current.generation);
    return [
      { generation: current.generation, sha: this.commit(`${SUBJECT} continues in generation ${next}\n`, current.tip, author) },
      { generation: next, sha: this.commit(encodeLease(record), null, author) },
      ...retired.map((g) => ({ generation: g.generation, sha: null })),
    ];
  }

  private commit(message: string, parent: string | null, author: Record<string, string>): string {
    const tree = this.git.okSync(["mktree"], "").trim();
    return this.git
      .with(author)
      .okSync(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-F", "-"], message)
      .trim();
  }

  /** The lease generations this Machine knows of, oldest first. */
  private generations(): Generation[] {
    const out = this.git.okSync(["for-each-ref", "--format=%(refname) %(objectname)", TRACKING]);
    return out
      .split("\n")
      .flatMap((line) => {
        const [ref, tip] = line.split(" ");
        const generation = Number(ref?.slice(TRACKING.length + 1));
        return ref && tip && Number.isSafeInteger(generation) && generation > 0 ? [{ generation, tip }] : [];
      })
      .sort((a, b) => a.generation - b.generation);
  }

  private remoteGit(remote: string): Git {
    return this.git.with(this.credentials.env(remote));
  }

  private credentialArgs(remote: string): string[] {
    return this.credentials.config(remote).flatMap((c) => ["-c", c]);
  }
}
