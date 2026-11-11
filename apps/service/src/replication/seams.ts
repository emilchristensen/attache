/**
 * Where later rules plug into Replication without changing the loop:
 * merge rules for files both sides changed, guards that run before every
 * commit and before talking to the remote, and the credentials git uses.
 * `replication/seams.ts` `defaultSeams()` is the one place they are listed.
 */
import { inboxMergeRule } from "../attention/inbox-merge.ts";
import { proposalMergeRule } from "../memory/proposal-merge.ts";
import { systemClock, type Clock } from "./clock.ts";
import { credentialScan } from "./credential-scan.ts";
import { deletedAndChangedRule } from "./deleted-and-changed.ts";
import { githubCredentials } from "./github-credentials.ts";
import { machineRecordRule } from "./machine-record-rule.ts";
import { NO_GITHUB, type GitHubAccess } from "./github.ts";
import { keepBothVersions } from "./note-merge/prose-versions.ts";
import { noteMergeRule } from "./note-merge/rule.ts";
import { PrivateRemoteGuard } from "./private-remote.ts";

/** A Machine as Replication names it: from local state for this one, from commit authors for others. */
export interface MachineRef {
  /** Null when a commit does not say (made outside Jarvis). */
  id: string | null;
  name: string;
}

export interface MergeInput {
  /** Path inside the Brain, with forward slashes. */
  path: string;
  /** The common ancestor's version; null when both sides added the file. */
  base: string | null;
  /** This Machine's version; null when this Machine deleted it. */
  ours: string | null;
  /** The other side's version; null when the other side deleted it. */
  theirs: string | null;
  local: MachineRef;
  /** The Machine that last changed the file on the other side. */
  remote: MachineRef;
  now: Date;
}

/** Something about a merge the owner should look at, e.g. prose kept in two versions. */
export interface MergeNotice {
  path: string;
  kind: string;
  message: string;
  /** A short headline for the inbox item; a generic one naming the path when left out. */
  title?: string;
  /**
   * One inbox item for the path while it stays open, however many merges raise
   * the notice, instead of one item per merge. For notices about the state of
   * a file that the owner settles by editing it.
   */
  perPath?: boolean;
}

export interface MergeOutcome {
  /** The merged file, or null to delete it. Never holds conflict markers. */
  content: string | null;
  notices?: readonly MergeNotice[];
}

/** Merges one file that both sides changed. */
export interface MergeRule {
  readonly name: string;
  appliesTo(path: string): boolean;
  /** Null when this rule cannot merge these versions; the next rule that applies is tried. */
  merge(input: MergeInput): MergeOutcome | null;
}

export interface StagedFile {
  path: string;
  change: "added" | "modified" | "deleted";
  /** The content about to be committed; null for a deletion. */
  read(): string | null;
  /**
   * The versions of this file in the commits this one builds on (HEAD, and
   * the other side's tip during a merge): what is in the shared history already.
   */
  committed?(): readonly string[];
}

export type GuardVerdict = { ok: true } | { ok: false; status: "blocked" | "unauthorized"; cause: string };

/** Runs before every commit; a refusal stops the commit and the push. */
export interface CommitGuard {
  readonly name: string;
  check(files: readonly StagedFile[]): GuardVerdict;
}

/** A remote guard's answer; `offline` when it could not find out this time, so the next check asks again. */
export type RemoteVerdict = GuardVerdict | { ok: false; status: "offline"; cause: string };

/** Runs at setup, at join and before every push; a refusal stops the push. */
export interface RemoteGuard {
  readonly name: string;
  check(remote: string): Promise<RemoteVerdict>;
}

/** How git authenticates to the remote, without the secret ever being part of its address. */
export interface GitCredentials {
  /** `-c key=value` settings for commands that talk to the remote, e.g. a credential helper. */
  config(remote: string): readonly string[];
  /** Environment for those commands. */
  env(remote: string): Readonly<Record<string, string>>;
}

export interface ReplicationSeams {
  mergeRules: readonly MergeRule[];
  commitGuards: readonly CommitGuard[];
  remoteGuards: readonly RemoteGuard[];
  credentials: GitCredentials;
}

/** Git's own credential setup on this Machine: what remotes other than GitHub over https use. */
export const MACHINE_CREDENTIALS: GitCredentials = { config: () => [], env: () => ({}) };

/** Settles one file as Replication does: the first rule that applies and returns an outcome wins. */
export function mergeByRules(rules: readonly MergeRule[], input: MergeInput): MergeOutcome | null {
  for (const rule of rules) {
    const outcome = rule.appliesTo(input.path) ? rule.merge(input) : null;
    if (outcome) return outcome;
  }
  return null;
}

/**
 * The merge rules, in the order Replication tries them: the first rule that
 * applies to a path and returns an outcome settles it.
 * 1. Any note (`*.md`) one side deleted and the other changed: the changed
 *    note is kept and an inbox item says so (#30). It must come before the
 *    note rule, which settles only notes both sides changed.
 * 2. Machine records (`machines/*.json`): the later `updatedAt` wins; a
 *    deletion loses (#35).
 * 3. Review state (`review/inbox/`, then `review/proposals/`, JSON): latest
 *    decision wins; a deletion wins over a change there.
 * 4. Notes both sides changed (`memory/**.md`): facts, History and frontmatter
 *    merge (#26), prose by a three-way line merge that keeps both versions of
 *    lines both sides changed (#27).
 */
function mergeRules(): readonly MergeRule[] {
  return [deletedAndChangedRule, machineRecordRule, inboxMergeRule, proposalMergeRule, noteMergeRule({ prose: keepBothVersions })];
}

/** What the service hands the seams that need more than the files. */
export interface SeamDeps {
  /** The GitHub connection, for the private-repository check and the repository token. */
  github?: GitHubAccess;
  clock?: Pick<Clock, "now">;
  /** This install's state folder and instance, for the credential helper git runs. */
  install?: { stateDir: string; instance: string };
}

/** The seams in use. Merge rules, guards and credentials are added here as they are built. */
export function defaultSeams(deps: SeamDeps = {}): ReplicationSeams {
  const github = deps.github ?? NO_GITHUB;
  const credentials = deps.install ? githubCredentials({ github, ...deps.install }) : MACHINE_CREDENTIALS;
  return {
    mergeRules: mergeRules(),
    commitGuards: [credentialScan],
    remoteGuards: [new PrivateRemoteGuard({ github, clock: deps.clock ?? systemClock })],
    credentials,
  };
}
