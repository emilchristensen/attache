import { lstatSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import type { FolderTreeWatch, FolderTreeWatchOptions } from "./folder-watch.ts";

interface FolderWatch {
  watcher: FSWatcher;
  /** The folder's inode: a different folder under the same name needs a new watch. */
  ino: bigint;
}

/** A path that is gone, or whose parent is no longer a folder: what a racing delete or replace leaves. */
const isGone = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/**
 * The folder's inode, or `null` when `path` is gone or is not a folder. Only the root is followed
 * when it is a symbolic link; a link below it is never a folder to watch.
 */
function folderIno(path: string, follow: boolean): bigint | null {
  try {
    const st = follow ? statSync(path, { bigint: true }) : lstatSync(path, { bigint: true });
    return st.isDirectory() ? st.ino : null;
  } catch (e) {
    if (isGone(e)) return null;
    throw e;
  }
}

/**
 * Watches a tree on Linux with one non-recursive inotify watch per folder, each with its own
 * error handling, instead of `fs.watch(root, { recursive: true })`.
 * Node implements recursive watching on Linux in JavaScript, and its event handler throws when a
 * watched folder is replaced by a file (ENOTDIR from `lstat`) or turns unreadable (EACCES). That
 * throw reaches no `'error'` listener and ends the process: https://github.com/nodejs/node/issues/66791,
 * with a fix proposed in https://github.com/nodejs/node/pull/66792 (still open with Node 26.13).
 * Symbolic links are not followed: the index never reads through them.
 */
export class LinuxFolderTreeWatch implements FolderTreeWatch {
  private readonly root: string;
  private readonly opts: FolderTreeWatchOptions;
  /** Absolute folder path to its watch. */
  private readonly folders = new Map<string, FolderWatch>();
  private closed = false;

  constructor(root: string, opts: FolderTreeWatchOptions) {
    this.root = root;
    this.opts = opts;
    try {
      this.watchTree(root);
    } catch (e) {
      this.close();
      throw e;
    }
  }

  close(): void {
    this.closed = true;
    for (const f of this.folders.values()) f.watcher.close();
    this.folders.clear();
  }

  /** Watch `folder` and every folder below it. Throws on any failure but a folder that went away meanwhile. */
  private watchTree(folder: string): void {
    if (this.closed || this.folders.has(folder)) return;
    try {
      const ino = this.ino(folder);
      if (ino === null) {
        if (folder === this.root) throw new Error(`${folder} is missing or is not a folder`);
        return;
      }
      const watcher = watch(folder, { persistent: false }, (_event, name) => this.onEvent(folder, watcher, name === null ? null : String(name)));
      watcher.on("error", (e) => this.onWatchError(watcher, e));
      this.folders.set(folder, { watcher, ino });
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (entry.isDirectory() && !this.opts.skipFolder?.(entry.name)) this.watchTree(join(folder, entry.name));
      }
    } catch (e) {
      // Its parent's watch reports the removal; the scan that follows settles the index.
      if (folder !== this.root && isGone(e)) {
        this.unwatchTree(folder);
        return;
      }
      throw e;
    }
  }

  /** Stop watching `folder` and every folder below it. */
  private unwatchTree(folder: string): void {
    const prefix = folder + sep;
    for (const [path, f] of this.folders) {
      if (path !== folder && !path.startsWith(prefix)) continue;
      f.watcher.close();
      this.folders.delete(path);
    }
  }

  private onEvent(folder: string, watcher: FSWatcher, name: string | null): void {
    // A closed watch can still deliver an event that was already queued.
    if (this.closed || this.folders.get(folder)?.watcher !== watcher) return;
    try {
      this.settle(folder, name);
    } catch (e) {
      this.fail(e as Error);
    }
  }

  /** Bring the watches in line with what changed in `folder`, then report it. */
  private settle(folder: string, name: string | null): void {
    // inotify reports a watched folder's own removal under the folder's name, which reads like an
    // entry of that name inside it, and the watch stays dead even when a new folder takes the old
    // one's place, often with the same inode. So an event under the folder's own name, or a
    // different inode, watches the folder again; a real entry of that name only costs a re-walk.
    const ino = this.ino(folder);
    if (name === basename(folder) || ino !== this.folders.get(folder)?.ino) {
      this.unwatchTree(folder);
      if (ino !== null) this.watchTree(folder);
      this.opts.onChange(this.rel(folder));
      return;
    }
    if (name === null) {
      this.opts.onChange(this.rel(folder));
      return;
    }
    const path = join(folder, name);
    const now = this.opts.skipFolder?.(name) ? null : this.ino(path);
    const watched = this.folders.get(path);
    if (watched && watched.ino !== now) this.unwatchTree(path);
    if (now !== null) this.watchTree(path);
    this.opts.onChange(this.rel(path));
  }

  private onWatchError(watcher: FSWatcher, e: Error): void {
    if (this.closed || ![...this.folders.values()].some((f) => f.watcher === watcher)) return;
    this.fail(e);
  }

  /** The watch can no longer be trusted: close it and let the owner of the watch start a new one. */
  private fail(e: Error): void {
    if (this.closed) return;
    this.close();
    this.opts.onError(e);
  }

  private ino(path: string): bigint | null {
    return folderIno(path, path === this.root);
  }

  /** `path` relative to the root, or `null` for the root itself (the OS gave no entry). */
  private rel(path: string): string | null {
    return path === this.root ? null : relative(this.root, path);
  }
}
