import { existsSync, watch, type FSWatcher } from "node:fs";
import type { Logger } from "../core/log.ts";
import type { Indexer, IndexRoot } from "./indexer.ts";

export interface WatcherOptions {
  /** Quiet period after the last file event before the index is updated. */
  debounceMs?: number;
  /** Longest a burst of events may hold back an update. */
  maxWaitMs?: number;
  /** Full incremental rescan interval, a safety net for events the OS dropped or coalesced. */
  rescanMs?: number;
  /** Delay before re-arming after the OS watcher fails (folder removed, too many watches). */
  retryMs?: number;
  /** Called after a flush that added, changed or removed indexed documents. */
  onChange?: () => void;
}

/**
 * Keeps one folder's index current with edits made outside the service (Obsidian, an editor, an
 * agent): a recursive OS watcher, debounced, plus a periodic rescan. Each changed path is
 * re-indexed alone; folder events and failures fall back to an incremental `scan`.
 */
export class FolderWatcher {
  private readonly indexer: Indexer;
  private readonly root: IndexRoot;
  private readonly log: Logger;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly rescanMs: number;
  private readonly retryMs: number;
  private readonly onChange: () => void;
  private fsWatcher: FSWatcher | null = null;
  private pending = new Set<string>();
  private needsScan = false;
  private firstEventAt = 0;
  private debounceTimer: NodeJS.Timeout | null = null;
  private rescanTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(indexer: Indexer, root: IndexRoot, log: Logger, opts: WatcherOptions = {}) {
    this.indexer = indexer;
    this.root = root;
    this.log = log;
    this.debounceMs = opts.debounceMs ?? 300;
    this.maxWaitMs = opts.maxWaitMs ?? 2_000;
    this.rescanMs = opts.rescanMs ?? 5 * 60_000;
    this.retryMs = opts.retryMs ?? 10_000;
    this.onChange = opts.onChange ?? (() => {});
  }

  get watching(): boolean {
    return this.fsWatcher !== null;
  }

  start(): void {
    this.stopped = false;
    this.arm();
    // The OS watcher takes a moment to deliver events; a catch-up scan covers edits made before then.
    this.queue(null);
    this.rescanTimer = setInterval(() => this.queue(null), this.rescanMs);
    this.rescanTimer.unref();
  }

  stop(): void {
    this.stopped = true;
    this.fsWatcher?.close();
    this.fsWatcher = null;
    for (const t of [this.debounceTimer, this.retryTimer]) if (t) clearTimeout(t);
    if (this.rescanTimer) clearInterval(this.rescanTimer);
    this.debounceTimer = this.retryTimer = this.rescanTimer = null;
    this.pending.clear();
    this.needsScan = false;
  }

  /** Apply everything queued now, instead of waiting for the debounce. */
  flush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    this.firstEventAt = 0;
    const paths = [...this.pending];
    this.pending = new Set();
    let scan = this.needsScan;
    this.needsScan = false;
    let changed = false;
    for (const rel of scan ? [] : paths) {
      try {
        const r = this.indexer.syncPath(this.root, rel);
        if (r === "rescan") scan = true;
        if (r === "changed") changed = true;
      } catch (e) {
        // The file changed again mid-read or became unreadable; the scan settles it.
        this.log.warn("could not index changed file", { root: this.root.id, path: rel, error: (e as Error).message });
        scan = true;
      }
    }
    // A missing root (unmounted or moved away) would look like every file was deleted.
    if (!existsSync(this.root.path)) {
      if (scan) this.log.warn("data folder is missing; index left as it was", { root: this.root.id, path: this.root.path });
      scan = false;
      // The OS watcher of a removed folder may stay silent forever (Linux): re-arm once it is back.
      if (this.fsWatcher) this.fail(new Error("data folder is missing"));
    }
    if (scan) {
      const r = this.indexer.scan(this.root);
      if (r.indexed || r.removed) changed = true;
      for (const e of r.errors.slice(0, 5)) this.log.warn("could not index file", { root: this.root.id, path: e.path, error: e.error });
    }
    if (changed) this.onChange();
  }

  private arm(): void {
    // Node before 24.22 on Linux watches a missing folder without an error, so check first.
    if (!existsSync(this.root.path)) {
      this.fail(new Error("data folder is missing"));
      return;
    }
    try {
      this.fsWatcher = watch(this.root.path, { recursive: true, persistent: false }, (_event, filename) => this.queue(filename ? String(filename) : null));
      this.fsWatcher.on("error", (e) => this.fail(e));
    } catch (e) {
      this.fail(e as Error);
    }
  }

  private fail(e: Error): void {
    this.log.warn("data folder watcher stopped; retrying", { root: this.root.id, path: this.root.path, error: e.message });
    this.fsWatcher?.close();
    this.fsWatcher = null;
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stopped) return;
      this.arm();
      // Edits made while unwatched are only found by a scan.
      this.queue(null);
    }, this.retryMs);
    this.retryTimer.unref();
  }

  /** Queue a changed path, or a full scan when the OS gives no path. */
  private queue(rel: string | null): void {
    if (this.stopped) return;
    if (rel === null) this.needsScan = true;
    else this.pending.add(rel);
    const now = Date.now();
    if (!this.firstEventAt) this.firstEventAt = now;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstEventAt + this.maxWaitMs - now));
    this.debounceTimer = setTimeout(() => this.safeFlush(), wait);
    this.debounceTimer.unref();
  }

  private safeFlush(): void {
    try {
      this.flush();
    } catch (e) {
      this.log.error("could not update the index after file changes", { root: this.root.id, error: (e as Error).message });
    }
  }
}
