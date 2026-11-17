import { watch } from "node:fs";
import { LinuxFolderTreeWatch } from "./linux-folder-watch.ts";
import { currentOs } from "./os.ts";

export interface FolderTreeWatch {
  close(): void;
}

export interface FolderTreeWatchOptions {
  /** Something changed at this path, relative to the root; `null` when the OS does not say where. */
  onChange: (rel: string | null) => void;
  /** The watch stopped working. The caller closes it and starts a new one. */
  onError: (e: Error) => void;
  /** Folders, by name, whose contents need no watching. Only Linux, which watches folder by folder, can leave them out. */
  skipFolder?: (name: string) => boolean;
}

/**
 * Watch a folder and everything below it. Throws when the folder itself cannot be watched;
 * every later failure goes to `onError`, never out of an event handler.
 */
export function watchFolderTree(root: string, opts: FolderTreeWatchOptions): FolderTreeWatch {
  if (currentOs() === "linux") return new LinuxFolderTreeWatch(root, opts);
  // macOS and Windows watch a whole tree natively (FSEvents, ReadDirectoryChangesW).
  const watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => opts.onChange(filename ? String(filename) : null));
  watcher.on("error", (e) => opts.onError(e));
  return watcher;
}
