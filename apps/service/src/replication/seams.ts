/**
 * Where later rules plug into Replication without changing the loop:
 * merge rules for files both sides changed, guards that run before every
 * commit and before talking to the remote, and the credentials git uses.
 * `replication/seams.ts` `defaultSeams()` is the one place they are listed.
 */
import { inboxMergeRule } from "../attention/inbox-merge.ts";
import { proposalMergeRule } from "../memory/proposal-merge.ts";
import { credentialScan } from "./credential-scan.ts";
import { noteMergeRule } from "./note-merge/rule.ts";

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

/** Runs at setup, at join and before every push; a refusal stops the push. */
export interface RemoteGuard {
  readonly name: string;
  check(remote: string): Promise<GuardVerdict>;
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

/** Git's own credential setup on this Machine, until a ticket adds Jarvis's helper. */
export const MACHINE_CREDENTIALS: GitCredentials = { config: () => [], env: () => ({}) };

/**
 * The merge rules, in the order Replication tries them: the first rule that
 * applies to a path and returns an outcome settles it. Order matters only
 * where rules share paths; each rule names the paths it covers.
 * 1. Review state (`review/inbox/`, then `review/proposals/`): latest decision wins.
 * 2. Notes (`memory/**.md`): the fact, History and frontmatter merge (#26).
 */
function mergeRules(): readonly MergeRule[] {
  return [inboxMergeRule, proposalMergeRule, noteMergeRule()];
}

/** The seams in use. Merge rules, guards and credentials are added here as they are built. */
export function defaultSeams(): ReplicationSeams {
  return {
    mergeRules: mergeRules(),
    commitGuards: [credentialScan],
    remoteGuards: [],
    credentials: MACHINE_CREDENTIALS,
  };
}
