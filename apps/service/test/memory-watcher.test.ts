import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDb } from "../src/core/db.ts";
import { createLogger } from "../src/core/log.ts";
import { Indexer, type IndexRoot } from "../src/memory/indexer.ts";
import { FolderWatcher, type WatcherOptions } from "../src/memory/watcher.ts";
import { search } from "../src/memory/search.ts";
import { tempDir } from "./helpers.ts";

const log = createLogger(null, { quiet: true });
const watchers: FolderWatcher[] = [];

afterEach(() => {
  for (const w of watchers.splice(0)) w.stop();
});

function setup() {
  const db = openDb(":memory:");
  const indexer = new Indexer(db);
  const path = tempDir();
  mkdirSync(join(path, "memory/notes"), { recursive: true });
  const root: IndexRoot = { id: "data", path, label: "data" };
  indexer.scan(root);
  const paths = () => search(db, "zebrafish", { limit: 50 }).map((h) => h.relPath);
  return { db, indexer, root, path, paths };
}

function note(path: string, rel: string, body = "The zebrafish migration starts in November.") {
  mkdirSync(join(path, rel, ".."), { recursive: true });
  writeFileSync(join(path, rel), `# Plan\n\n${body}\n`);
}

async function until(check: () => boolean, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("Indexer.syncPath", () => {
  it("indexes created and edited files and forgets deleted ones", () => {
    const { indexer, root, path, paths } = setup();
    note(path, "memory/notes/z.md");
    expect(indexer.syncPath(root, "memory/notes/z.md")).toBe("changed");
    expect(paths()).toEqual(["memory/notes/z.md"]);
    expect(indexer.syncPath(root, "memory/notes/z.md")).toBe("unchanged");
    rmSync(join(path, "memory/notes/z.md"));
    expect(indexer.syncPath(root, "memory/notes/z.md")).toBe("changed");
    expect(paths()).toEqual([]);
    expect(indexer.syncPath(root, "memory/notes/z.md")).toBe("unchanged");
  });

  it("asks for a scan for folders and for vanished non-Markdown paths", () => {
    const { indexer, root, path } = setup();
    mkdirSync(join(path, "memory/archive"));
    expect(indexer.syncPath(root, "memory/archive")).toBe("rescan");
    expect(indexer.syncPath(root, "memory/gone")).toBe("rescan");
    expect(indexer.syncPath(root, "../escape.md")).toBe("rescan");
  });

  it("never indexes hidden, non-Markdown, oversized or symlinked files", () => {
    const { indexer, root, path, paths } = setup();
    note(path, ".trash/z.md");
    note(path, "memory/.hidden.md");
    note(path, "memory/notes/z.txt");
    writeFileSync(join(path, "memory/big.md"), `zebrafish ${"x".repeat(2 * 1024 * 1024)}`);
    const outside = tempDir();
    note(outside, "s.md");
    symlinkSync(join(outside, "s.md"), join(path, "memory/link.md"));
    symlinkSync(outside, join(path, "memory/linked"));
    for (const rel of [".trash/z.md", "memory/.hidden.md", "memory/notes/z.txt"]) expect(indexer.syncPath(root, rel)).toBe("ignored");
    for (const rel of ["memory/big.md", "memory/link.md", "memory/linked/s.md"]) expect(indexer.syncPath(root, rel)).toBe("unchanged");
    expect(paths()).toEqual([]);
  });

  it("drops a file once it is replaced by a symlink", () => {
    const { indexer, root, path, paths } = setup();
    note(path, "memory/notes/z.md");
    indexer.syncPath(root, "memory/notes/z.md");
    const outside = tempDir();
    note(outside, "s.md");
    rmSync(join(path, "memory/notes/z.md"));
    symlinkSync(join(outside, "s.md"), join(path, "memory/notes/z.md"));
    expect(indexer.syncPath(root, "memory/notes/z.md")).toBe("changed");
    expect(paths()).toEqual([]);
  });
});

describe("FolderWatcher", () => {
  /** Start a watcher and wait until it delivers events, proven by a sentinel file getting indexed. */
  async function watcher(s: ReturnType<typeof setup>, opts: WatcherOptions = {}) {
    const w = new FolderWatcher(s.indexer, s.root, log, { debounceMs: 50, ...opts });
    watchers.push(w);
    w.start();
    await until(() => w.watching);
    for (let i = 0; ; i++) {
      writeFileSync(join(s.path, "memory/ready.md"), `# Ready\n\nsentinel${i}\n`);
      const indexed = await until(() => search(s.db, `sentinel${i}`).length === 1, 300).then(() => true, () => false);
      if (indexed) break;
    }
    rmSync(join(s.path, "memory/ready.md"));
    await until(() => search(s.db, "ready").length === 0);
    return w;
  }

  it("indexes hand-made creates, edits, moves and deletes without a restart", async () => {
    const s = setup();
    let changes = 0;
    await watcher(s, { onChange: () => changes++ });
    note(s.path, "memory/notes/z.md");
    await until(() => s.paths().join() === "memory/notes/z.md");
    expect(changes).toBeGreaterThan(0);

    note(s.path, "memory/notes/z.md", "The zebrafish migration slipped to December.");
    await until(() => search(s.db, "December").length === 1);

    mkdirSync(join(s.path, "memory/projects"));
    renameSync(join(s.path, "memory/notes/z.md"), join(s.path, "memory/projects/z.md"));
    await until(() => s.paths().join() === "memory/projects/z.md");

    rmSync(join(s.path, "memory/projects/z.md"));
    await until(() => s.paths().length === 0);
  });

  it("re-indexes every file under a moved or deleted folder", async () => {
    const s = setup();
    note(s.path, "memory/notes/a.md");
    note(s.path, "memory/notes/b.md");
    await watcher(s);
    await until(() => s.paths().length === 2);
    renameSync(join(s.path, "memory/notes"), join(s.path, "memory/archive"));
    await until(() => s.paths().sort().join() === "memory/archive/a.md,memory/archive/b.md");
    rmSync(join(s.path, "memory/archive"), { recursive: true });
    await until(() => s.paths().length === 0);
  });

  it("debounces a burst of events into one update", async () => {
    const s = setup();
    let changes = 0;
    await watcher(s, { debounceMs: 300, maxWaitMs: 10_000, onChange: () => changes++ });
    changes = 0;
    for (let i = 0; i < 20; i++) note(s.path, `memory/notes/n${i}.md`);
    await until(() => changes > 0);
    expect(s.paths()).toHaveLength(20);
    await new Promise((r) => setTimeout(r, 400));
    expect(changes).toBe(1);
  });

  it("keeps the index when the folder is missing, and keeps retrying the watch", async () => {
    const s = setup();
    note(s.path, "memory/notes/z.md");
    s.indexer.scan(s.root);
    // Same root id, folder gone (an unmounted drive): a scan would read that as every file deleted.
    const w = new FolderWatcher(s.indexer, { ...s.root, path: `${s.path}-gone` }, log, { debounceMs: 10, retryMs: 20 });
    watchers.push(w);
    w.start();
    expect(w.watching).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(s.paths()).toEqual(["memory/notes/z.md"]);
  });

  it("watches the folder again once it comes back after going missing", async () => {
    const s = setup();
    const w = await watcher(s, { retryMs: 50 });
    rmSync(s.path, { recursive: true });
    await until(() => !w.watching);
    note(s.path, "memory/notes/z.md");
    await until(() => s.paths().join() === "memory/notes/z.md");
    note(s.path, "memory/notes/z.md", "The zebrafish migration slipped to December.");
    await until(() => search(s.db, "December").length === 1);
  });
});
