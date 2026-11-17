import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Coverage } from "@attache/contracts";
import type { Db } from "../core/db.ts";
import { unresolvedItems, type ApplyResult, type CandidateWithSource } from "../attention/engine.ts";
import { fingerprint } from "../attention/fingerprint.ts";
import { holdsTwoVersions, PROSE_VERSIONS } from "./note-merge/prose-versions.ts";
import type { MergeNotice } from "./seams.ts";

/**
 * Inbox items raised by merges carry this source. It is not the blocked item's
 * `replication` source: that one is about this Machine alone and is refreshed
 * with complete coverage, which would resolve every other item of its source.
 * Merge items replicate like any inbox item, so every Machine shows them.
 */
export const MERGE_NOTICE_SOURCE = "replication_merge";
const PRIORITY = 60;

/** The inbox item kind of a notice kind. */
export const noticeItemKind = (kind: string) => `replication_${kind}`;

function candidate(notice: MergeNotice, at: string): CandidateWithSource {
  // Never the merge's time: two Machines that merge the same thing raise one item.
  // A per-path notice is one item while it is open; after it resolved, a new merge raises it again.
  // Any other notice is one item per thing merged (its version), so a different merge of the same note is news again.
  const parts = notice.perPath ? [notice.kind, notice.path] : [notice.kind, notice.path, notice.version ?? fingerprint([notice.message])];
  return {
    key: `replication:${parts.join(":")}`,
    kind: noticeItemKind(notice.kind),
    title: notice.title ?? `Replication merged ${notice.path}`,
    summary: notice.message,
    why: "Two Machines changed the Brain at the same time, and Attache settled it without asking.",
    priority: PRIORITY,
    sourceKind: MERGE_NOTICE_SOURCE,
    connectionId: null,
    fingerprint: fingerprint(parts),
    evidence: [{ label: notice.path, relPath: notice.path, observedAt: at }],
  };
}

/** Where merge items go: the inbox, which also writes them to the Brain so they replicate. */
export interface MergeNoticeInbox {
  apply(source: { sourceKind: string; connectionId: string | null; coverage: Coverage; previousCoverage: Coverage | null }, candidates: CandidateWithSource[]): ApplyResult;
}

/**
 * Raise one inbox item for each thing a merge rule wants the owner to look at.
 * The Machine that made the merge raises it; the item replicates to the others.
 * Nothing resolves these items but the owner's decision, or `settledMergeNotices`
 * for the kinds it knows how to check.
 */
export function raiseMergeNotices(inbox: MergeNoticeInbox, notices: readonly MergeNotice[], at: Date): string[] {
  if (!notices.length) return [];
  const iso = at.toISOString();
  // Never "complete": a merge only reports what it found, so it must not resolve earlier items.
  const coverage: Coverage = { state: "partial", scopes: [], items: notices.length, at: iso };
  return inbox.apply({ sourceKind: MERGE_NOTICE_SOURCE, connectionId: null, coverage, previousCoverage: null }, notices.map((n) => candidate(n, iso))).created;
}

/** Whether the file a notice is about no longer needs the owner: its content now, null when it is gone. */
export type NoticeSettled = (content: string | null) => boolean;

/**
 * The merge items the owner has settled by editing their file, here or on
 * another Machine, for the inbox to resolve. `settled` names the notice kinds
 * that can be checked this way; `read` gives a Brain file's content, or null
 * when it is missing.
 */
export function settledMergeNotices(db: Db, settled: Readonly<Record<string, NoticeSettled>>, read: (path: string) => string | null): string[] {
  const checks = new Map(Object.entries(settled).map(([kind, check]) => [noticeItemKind(kind), check]));
  return unresolvedItems(db, MERGE_NOTICE_SOURCE)
    .filter((item) => {
      const check = checks.get(item.kind);
      const path = item.evidence[0]?.relPath;
      return check !== undefined && path !== undefined && check(read(path));
    })
    .map((i) => i.key);
}

/** The notice kinds the owner settles by editing the file: a note with two versions is settled once it no longer holds both. */
export const SETTLED_BY_EDIT: Readonly<Record<string, NoticeSettled>> = {
  [PROSE_VERSIONS]: (content) => content === null || !holdsTwoVersions(content),
};

/** Reads a file of the Brain at `root` by its Brain path; null when it is missing or the path leads outside the Brain. */
export function brainFileReader(root: string): (path: string) => string | null {
  return (path) => {
    const abs = resolve(root, path);
    const rel = relative(root, abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
    try {
      return readFileSync(abs, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  };
}
