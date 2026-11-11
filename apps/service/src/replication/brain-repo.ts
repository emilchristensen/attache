import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Git, GitError } from "./git.ts";
import { machineTrailer, type StagedEntry } from "./commit-message.ts";
import type { GuardVerdict, MachineRef, MergeNotice, MergeOutcome as MergedFile, ReplicationSeams, StagedFile } from "./seams.ts";

export const BRANCH = "main";
export const REMOTE = "origin";
const TRACKING = `refs/remotes/${REMOTE}/${BRANCH}`;
const MACHINE_EMAIL_DOMAIN = "machine.jarvis.invalid";

export type CommitOutcome = { kind: "nothing" } | { kind: "committed"; staged: StagedEntry[] } | { kind: "refused"; verdict: Exclude<GuardVerdict, { ok: true }> };

export type PullOutcome =
  | { kind: "none" }
  | { kind: "merged"; changed: string[]; notices: MergeNotice[] }
  | { kind: "blocked"; cause: string; status: "blocked" | "unauthorized" }
  /** Something got in the way this time (a file edited mid-merge); the next check tries again. */
  | { kind: "retry"; cause: string };

/** A Machine's name and id as a git author, so every commit says where it came from. */
export function authorEnv(machine: MachineRef & { id: string }, at: Date): Record<string, string> {
  const name = machine.name.replace(/[<>\n\r]/g, "").trim() || "Jarvis";
  const email = `${machine.id}@${MACHINE_EMAIL_DOMAIN}`;
  const date = at.toISOString();
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_AUTHOR_DATE: date, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email, GIT_COMMITTER_DATE: date };
}

function machineOfAuthor(name: string, email: string): MachineRef {
  const id = email.endsWith(`@${MACHINE_EMAIL_DOMAIN}`) ? email.slice(0, -MACHINE_EMAIL_DOMAIN.length - 1) : null;
  return { id, name };
}

function splitZ(out: string): string[] {
  return out.split("\0").filter(Boolean);
}

const GIT_CHANGE: Record<string, StagedEntry["change"]> = { A: "added", M: "modified", T: "modified", D: "deleted" };

/**
 * The Brain's git repository on this Machine. Everything that changes the
 * working tree runs synchronously, so no save can land halfway through it;
 * only fetch and push wait on the network.
 */
export class BrainRepo {
  readonly git: Git;
  private readonly seams: ReplicationSeams;

  constructor(git: Git, seams: ReplicationSeams) {
    this.git = git;
    this.seams = seams;
  }

  get root(): string {
    return this.git.cwd;
  }

  isRepository(): boolean {
    return existsSync(join(this.root, ".git"));
  }

  private revParse(ref: string): string | null {
    const r = this.git.runSync(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  private isAncestor(a: string, b: string): boolean {
    return this.git.runSync(["merge-base", "--is-ancestor", a, b]).code === 0;
  }

  /** What is staged, compared with the last commit. */
  staged(): StagedEntry[] {
    const parts = splitZ(this.git.okSync(["diff", "--cached", "--name-status", "--no-renames", "-z"]));
    const out: StagedEntry[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) out.push({ path: parts[i + 1]!, change: GIT_CHANGE[parts[i]![0]!] ?? "modified" });
    return out;
  }

  private guard(staged: readonly StagedEntry[]): GuardVerdict {
    const files: StagedFile[] = staged.map((s) => ({ path: s.path, change: s.change, read: () => (s.change === "deleted" ? null : this.git.okSync(["cat-file", "blob", `:${s.path}`])) }));
    for (const g of this.seams.commitGuards) {
      const v = g.check(files);
      if (!v.ok) return v;
    }
    return { ok: true };
  }

  private unstage(): void {
    // On a repository with no commit yet there is nothing to go back to; the index is simply rebuilt next time.
    this.git.runSync(["reset", "-q"]);
  }

  /** Commit every change in the data folder, hand edits included, after the commit guards agree. */
  commitAll(author: Record<string, string>, message: (staged: StagedEntry[]) => string): CommitOutcome {
    this.git.okSync(["add", "-A"]);
    const staged = this.staged();
    if (!staged.length) return { kind: "nothing" };
    const verdict = this.guard(staged);
    if (!verdict.ok) {
      this.unstage();
      return { kind: "refused", verdict };
    }
    this.git.with(author).okSync(["commit", "-q", "--no-verify", "-F", "-"], message(staged));
    return { kind: "committed", staged };
  }

  /** A merge a crash interrupted is abandoned, so the next check starts it again cleanly. */
  abortInterruptedMerge(): boolean {
    if (!existsSync(join(this.root, ".git", "MERGE_HEAD"))) return false;
    this.git.okSync(["merge", "--abort"]);
    return true;
  }

  /** Commits on this Machine that the remote does not have yet. */
  ahead(): number {
    const range = this.revParse(TRACKING) ? `${TRACKING}..HEAD` : "HEAD";
    return Number(this.git.okSync(["rev-list", "--count", range]).trim());
  }

  async fetch(remote: string): Promise<void> {
    await this.git.with(this.seams.credentials.env(remote)).ok([...this.credentialArgs(remote), "fetch", "--quiet", "--no-tags", REMOTE, `+refs/heads/${BRANCH}:${TRACKING}`]);
  }

  /** Push this Machine's commits. Only ever a fast-forward: a rejection means another Machine pushed first. */
  async push(remote: string): Promise<void> {
    await this.git.with(this.seams.credentials.env(remote)).ok([...this.credentialArgs(remote), "push", "--quiet", REMOTE, `HEAD:refs/heads/${BRANCH}`]);
  }

  private credentialArgs(remote: string): string[] {
    return this.seams.credentials.config(remote).flatMap((c) => ["-c", c]);
  }

  private changedBetween(a: string, b: string): string[] {
    return splitZ(this.git.okSync(["diff", "--name-only", "--no-renames", "-z", a, b]));
  }

  /** Bring in what was fetched: a fast-forward when this Machine has nothing new, otherwise a merge commit. */
  mergeFetched(local: MachineRef & { id: string }, at: Date): PullOutcome {
    const head = this.revParse("HEAD");
    const theirs = this.revParse(TRACKING);
    if (!head || !theirs || this.isAncestor(theirs, head)) return { kind: "none" };
    if (this.isAncestor(head, theirs)) {
      const r = this.git.runSync(["merge", "--ff-only", "--quiet", theirs]);
      if (r.code !== 0) return { kind: "retry", cause: new GitError("failed", "merge", r.stderr).cause };
      return { kind: "merged", changed: this.changedBetween(head, theirs), notices: [] };
    }
    const r = this.git.runSync(["merge", "--no-ff", "--no-commit", "--quiet", theirs]);
    if (r.code !== 0 && !existsSync(join(this.root, ".git", "MERGE_HEAD"))) return { kind: "retry", cause: new GitError("failed", "merge", r.stderr).cause };
    const resolved = this.resolveConflicts(local, theirs, at);
    if (resolved.kind === "blocked") {
      this.git.okSync(["merge", "--abort"]);
      return resolved;
    }
    const staged = this.staged();
    const verdict = this.guard(staged);
    if (!verdict.ok) {
      this.git.okSync(["merge", "--abort"]);
      return { kind: "blocked", cause: verdict.cause, status: verdict.status };
    }
    const from = [...new Set(splitZ(this.git.okSync(["log", "-z", "--format=%an", `${head}..${theirs}`])))];
    const message = [`${local.name}: merge changes from ${from.join(", ") || "another Machine"}`, "", machineTrailer(local)].join("\n");
    this.git.with(authorEnv(local, at)).okSync(["commit", "-q", "--no-verify", "-F", "-"], message);
    return { kind: "merged", changed: this.changedBetween(head, "HEAD"), notices: resolved.notices };
  }

  /** Settle every file both sides changed with the merge rules; a file no rule settles blocks the merge. */
  private resolveConflicts(local: MachineRef, theirs: string, at: Date): { kind: "resolved"; notices: MergeNotice[] } | { kind: "blocked"; cause: string; status: "blocked" } {
    const stages = new Map<string, Partial<Record<1 | 2 | 3, string>>>();
    for (const entry of splitZ(this.git.okSync(["ls-files", "-u", "-z"]))) {
      const m = /^\d+ ([0-9a-f]+) ([123])\t(.+)$/s.exec(entry);
      if (m) stages.set(m[3]!, { ...stages.get(m[3]!), [Number(m[2]) as 1 | 2 | 3]: m[1]! });
    }
    const notices: MergeNotice[] = [];
    const unresolved: string[] = [];
    for (const [path, s] of stages) {
      const blob = (sha?: string) => (sha ? this.git.okSync(["cat-file", "blob", sha]) : null);
      const input = { path, base: blob(s[1]), ours: blob(s[2]), theirs: blob(s[3]), local, remote: this.lastAuthor(theirs, path), now: at };
      let outcome: MergedFile | null = null;
      for (const rule of this.seams.mergeRules) {
        if (rule.appliesTo(path)) outcome = rule.merge(input);
        if (outcome) break;
      }
      if (!outcome) {
        unresolved.push(path);
        continue;
      }
      this.writeResolved(path, outcome.content);
      notices.push(...(outcome.notices ?? []));
    }
    if (unresolved.length) return { kind: "blocked", status: "blocked", cause: `Both Machines changed ${unresolved.join(", ")} and Jarvis has no rule to merge ${unresolved.length === 1 ? "it" : "them"}. Edit the file on one Machine to match the other.` };
    return { kind: "resolved", notices };
  }

  private writeResolved(path: string, content: string | null): void {
    const abs = join(this.root, path);
    if (content === null) {
      rmSync(abs, { force: true });
      this.git.okSync(["rm", "-q", "--cached", "--ignore-unmatch", "--", path]);
      return;
    }
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = join(dirname(abs), `.${randomUUID()}.tmp`);
    writeFileSync(tmp, content);
    renameSync(tmp, abs);
    this.git.okSync(["add", "--", path]);
  }

  /** When the Machine with `id` last authored a commit in this copy's history; null when it never has. */
  lastChangeBy(id: string): string | null {
    if (!this.revParse("HEAD")) return null;
    const at = this.git.okSync(["log", "-1", "--format=%aI", "--fixed-strings", `--author=<${id}@${MACHINE_EMAIL_DOMAIN}>`, "HEAD"]).trim();
    return at ? new Date(at).toISOString() : null;
  }

  private lastAuthor(ref: string, path: string): MachineRef {
    const [name = "another Machine", email = ""] = this.git.okSync(["log", "-1", "--format=%an%x00%ae", ref, "--", path]).trim().split("\0");
    return machineOfAuthor(name, email);
  }
}
