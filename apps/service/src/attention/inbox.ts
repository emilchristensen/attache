import { existsSync } from "node:fs";
import { join } from "node:path";
import type { AttentionItemView, Coverage } from "@jarvis/contracts";
import type { Db } from "../core/db.ts";
import type { Logger } from "../core/log.ts";
import { isReviewPath, listReviewFiles, readReviewFile, removeReviewFile, reviewPath, writeReviewFile } from "../review-state/files.ts";
import {
  allRecords,
  applyCandidates,
  decide,
  deleteConnection,
  forgetItem,
  recordByKey,
  rederiveStates,
  resolveConnection,
  resolveItems,
  takeRecord,
  type ApplyResult,
  type CandidateWithSource,
  type InboxContext,
} from "./engine.ts";
import { parseInboxRecord, type InboxDecisionKind, type InboxRecord } from "./inbox-record.ts";

export interface InboxDeps {
  db: Db;
  log: Logger;
  ctx: InboxContext;
  /** The data folder that is open now, if any. */
  dataRoot: () => string | null;
  /** The inbox's files in the Brain changed: Replication commits them after a quiet spell. */
  onWrite: () => void;
  /** Items changed in a way the Dashboard should show. */
  onChange: () => void;
  /** Sources whose items are about this Machine alone, such as its own Replication status: they never enter the Brain. */
  localSources: readonly string[];
}

/**
 * The owner's inbox. Each Machine keeps its items in its database, and every
 * item with the owner's latest decision is also a file in the Brain
 * (`review/inbox/`), so the inbox replicates. Files another Machine changed
 * are taken in through `pulled`. Items from local sources stay on this Machine.
 */
export class Inbox {
  private readonly d: InboxDeps;

  constructor(deps: InboxDeps) {
    this.d = deps;
  }

  apply(source: { sourceKind: string; connectionId: string | null; coverage: Coverage; previousCoverage: Coverage | null }, candidates: CandidateWithSource[], briefingId: string | null = null): ApplyResult {
    const out = applyCandidates(this.d.db, source, candidates, briefingId, this.d.ctx);
    this.write(out.touched);
    return out;
  }

  decide(id: string, decision: InboxDecisionKind, actor: string, until?: string): AttentionItemView {
    const item = decide(this.d.db, id, decision, actor, until, this.d.ctx);
    this.write([item.key]);
    return item;
  }

  /** Resolve these items, as their source says they are settled. Returns the keys it resolved. */
  resolve(keys: readonly string[]): string[] {
    if (!keys.length) return [];
    const resolved = resolveItems(this.d.db, keys, this.d.ctx);
    this.write(resolved);
    return resolved;
  }

  /** A connection was disconnected: its items are resolved, or deleted when the owner asked for that. */
  disconnected(connectionId: string, deleteData: boolean): void {
    this.write(deleteData ? deleteConnection(this.d.db, connectionId) : resolveConnection(this.d.db, connectionId, this.d.ctx));
  }

  /**
   * Work every item's state out again from its record when the service starts, whether or not
   * a data folder opens: a state an earlier release left in the database never outlives the upgrade.
   */
  load(): void {
    const keys = rederiveStates(this.d.db, this.d.ctx.now());
    if (!keys.length) return;
    this.d.log.info("worked inbox states out again from their records", { keys });
    this.d.onChange();
  }

  /**
   * End snoozes whose time has passed. Only the state this Machine works out from each record
   * changes; the record keeps its report time, so it never looks newer than another Machine's report.
   */
  wake(): void {
    if (rederiveStates(this.d.db, this.d.ctx.now()).length) this.d.onChange();
  }

  /**
   * Bring the database and the Brain's inbox files together when a data folder
   * opens: files win (they are what every Machine agrees on), and items only
   * this Machine knows, such as those from before the inbox replicated, are written out.
   */
  reconcile(): void {
    const root = this.d.dataRoot();
    if (!root) return;
    const onDisk = new Set<string>();
    let changed = false;
    for (const rel of listReviewFiles(root, "inbox")) {
      const rec = this.read(root, rel);
      if (!rec) continue;
      onDisk.add(rec.key);
      if (takeRecord(this.d.db, rec, this.d.ctx.now())) changed = true;
    }
    this.write(this.replicated(allRecords(this.d.db)).filter((r) => !onDisk.has(r.key)).map((r) => r.key));
    if (changed) this.d.onChange();
  }

  /** Files another Machine changed: take in the inbox's. */
  pulled(paths: readonly string[]): void {
    const root = this.d.dataRoot();
    const mine = paths.filter((p) => isReviewPath(p, "inbox"));
    if (!root || !mine.length) return;
    const now = this.d.ctx.now();
    let changed = false;
    const keysByPath = new Map(this.replicated(allRecords(this.d.db)).map((r) => [reviewPath("inbox", r.key), r.key]));
    for (const rel of mine) {
      const rec = this.read(root, rel);
      if (rec) {
        if (takeRecord(this.d.db, rec, now)) changed = true;
        continue;
      }
      const key = keysByPath.get(rel);
      if (key && !existsSync(join(root, rel)) && forgetItem(this.d.db, key)) changed = true;
    }
    if (changed) this.d.onChange();
  }

  private isLocal(rec: InboxRecord): boolean {
    return this.d.localSources.includes(rec.item.sourceKind);
  }

  private replicated(records: readonly InboxRecord[]): InboxRecord[] {
    return records.filter((r) => !this.isLocal(r));
  }

  /** The record in a file of the Brain's inbox, or null when it is missing, unreadable or about another Machine alone. */
  private read(root: string, rel: string): InboxRecord | null {
    const value = readReviewFile(root, rel);
    if (value === null) return null;
    const rec = parseInboxRecord(value);
    if (!rec || reviewPath("inbox", rec.key) !== rel || this.isLocal(rec)) {
      this.d.log.warn("ignored an inbox file Jarvis cannot take in", { path: rel });
      return null;
    }
    return rec;
  }

  /** Write the files of these items, or remove them for items that are gone. */
  private write(keys: readonly string[]): void {
    const root = this.d.dataRoot();
    if (!root || !keys.length) return;
    for (const key of new Set(keys)) {
      const rel = reviewPath("inbox", key);
      const rec = recordByKey(this.d.db, key);
      if (rec && this.isLocal(rec)) continue;
      try {
        if (rec) writeReviewFile(root, rel, rec);
        else removeReviewFile(root, rel);
      } catch (e) {
        this.d.log.error("could not write an inbox item to the Brain", { path: rel, error: (e as Error).message });
      }
    }
    this.d.onWrite();
  }
}
