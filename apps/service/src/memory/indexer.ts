import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync, lstatSync } from "node:fs";
import { join, relative, sep, basename } from "node:path";
import { type Db, nowIso, tx } from "../core/db.ts";
import { chunkSection } from "./chunker.ts";
import { parseMarkdown } from "./markdown.ts";
import { areaOf, type Area } from "./policy.ts";

export interface IndexRoot {
  /** "data" for the Jarvis data folder, "import:<id>" for imported folders. */
  id: string;
  path: string;
  label: string;
}

const SKIP_DIRS = new Set([".git", ".obsidian", ".trash", "node_modules", ".jarvis", ".DS_Store"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface ScanPlan {
  read: string[];
  skipped: Array<{ path: string; reason: string }>;
  totalBytes: number;
}

/** List what an import would read, without reading contents. */
export function planScan(rootPath: string, limit = 50_000): ScanPlan {
  const plan: ScanPlan = { read: [], skipped: [], totalBytes: 0 };
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (e) {
      plan.skipped.push({ path: relative(rootPath, dir) || ".", reason: `unreadable: ${(e as Error).message}` });
      return;
    }
    for (const name of entries.sort()) {
      const abs = join(dir, name);
      const rel = relative(rootPath, abs).split(sep).join("/");
      let st;
      try {
        st = lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        plan.skipped.push({ path: rel, reason: "symbolic link (not followed)" });
        continue;
      }
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name) || name.startsWith(".")) {
          plan.skipped.push({ path: rel + "/", reason: "hidden or tool folder" });
          continue;
        }
        walk(abs);
      } else if (st.isFile()) {
        if (!name.toLowerCase().endsWith(".md")) continue;
        if (st.size > MAX_FILE_BYTES) {
          plan.skipped.push({ path: rel, reason: "larger than 2 MB" });
          continue;
        }
        if (plan.read.length >= limit) {
          plan.skipped.push({ path: rel, reason: "file limit reached" });
          continue;
        }
        plan.read.push(rel);
        plan.totalBytes += st.size;
      }
    }
  };
  walk(rootPath);
  return plan;
}

export function docId(rootId: string, rel: string): string {
  return createHash("sha256").update(`${rootId}\0${rel}`).digest("hex").slice(0, 24);
}

function areaFor(root: IndexRoot, rel: string): Area {
  if (root.id !== "data") return "import";
  return areaOf(rel) ?? "import";
}

export interface IndexResult {
  indexed: number;
  unchanged: number;
  removed: number;
  errors: Array<{ path: string; error: string }>;
}

/** What a chunk's meaning vector is made from: the same title, heading and text that keyword search matches. */
export function embedText(title: string, heading: string, text: string): string {
  return [title, heading, text].filter(Boolean).join("\n");
}

export class Indexer {
  private readonly db: Db;
  private readonly listeners = new Set<() => void>();
  constructor(db: Db) {
    this.db = db;
  }

  /** Call `listener` after chunks were added or removed. Returns a function that stops the calls. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const l of this.listeners) l();
  }

  indexFile(root: IndexRoot, rel: string): "indexed" | "unchanged" {
    const abs = join(root.path, rel);
    const st = statSync(abs);
    const raw = readFileSync(abs, "utf8");
    const hash = createHash("sha256").update(raw).digest("hex");
    const id = docId(root.id, rel);
    const existing = this.db.prepare("select hash from documents where id = ?").get(id) as { hash: string } | undefined;
    if (existing?.hash === hash) {
      this.db.prepare("update documents set mtime_ms = ? where id = ?").run(Math.floor(st.mtimeMs), id);
      return "unchanged";
    }
    const parsed = parseMarkdown(raw, basename(rel, ".md"));
    const area = areaFor(root, rel);
    const docType = typeof parsed.frontmatter.type === "string" ? parsed.frontmatter.type : area === "memory" ? rel.split("/")[1]?.replace(/s$/, "") ?? null : null;
    tx(this.db, () => {
      this.removeChunks(id);
      this.db
        .prepare(
          `insert into documents (id, root, rel_path, area, doc_type, title, hash, mtime_ms, meta, indexed_at)
           values (?,?,?,?,?,?,?,?,?,?)
           on conflict(id) do update set area=excluded.area, doc_type=excluded.doc_type, title=excluded.title, hash=excluded.hash,
             mtime_ms=excluded.mtime_ms, meta=excluded.meta, indexed_at=excluded.indexed_at`,
        )
        .run(id, root.id, rel, area, docType, parsed.title, hash, Math.floor(st.mtimeMs), JSON.stringify(parsed.frontmatter), nowIso());
      const insChunk = this.db.prepare(
        "insert into chunks (doc_id, ordinal, heading, start_line, end_line, section, text, embed_text, embed_hash) values (?,?,?,?,?,?,?,?,?)",
      );
      const insFts = this.db.prepare("insert into chunks_fts (rowid, title, heading, text) values (?,?,?,?)");
      let ordinal = 0;
      for (const s of parsed.sections) {
        const { kind, chunks } = chunkSection(s);
        for (const c of chunks) {
          const heading = [s.heading, c.searchHeading].filter(Boolean).join(" ");
          const searchText = c.searchText ?? c.text;
          const meaning = embedText(parsed.title, heading, searchText);
          const r = insChunk.run(id, ordinal++, s.heading, c.startLine, c.endLine, kind, c.text, meaning, createHash("sha256").update(meaning).digest("hex"));
          insFts.run(Number(r.lastInsertRowid), parsed.title, heading, searchText);
        }
      }
    });
    this.changed();
    return "indexed";
  }

  private removeChunks(docIdValue: string) {
    const rows = this.db.prepare("select id from chunks where doc_id = ?").all(docIdValue) as Array<{ id: number }>;
    const del = this.db.prepare("delete from chunks_fts where rowid = ?");
    for (const r of rows) del.run(r.id);
    this.db.prepare("delete from chunks where doc_id = ?").run(docIdValue);
  }

  removeFile(rootId: string, rel: string): void {
    const id = docId(rootId, rel);
    tx(this.db, () => {
      this.removeChunks(id);
      this.db.prepare("delete from documents where id = ?").run(id);
    });
    this.changed();
  }

  /**
   * Bring one path's index entry in line with the file on disk, by the same rules as `scan`:
   * hidden and tool folders, symbolic links (the file or any parent inside the root), non-Markdown
   * and oversized files are never indexed. Folders, and paths that are gone but are not Markdown
   * files (a moved or deleted folder), need a full scan.
   */
  syncPath(root: IndexRoot, rel: string): "changed" | "unchanged" | "ignored" | "rescan" {
    const parts = rel.split(sep).join("/").split("/").filter((p) => p && p !== ".");
    if (!parts.length || parts.includes("..")) return "rescan";
    if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p) || p.startsWith("."))) return "ignored";
    const n = parts.join("/");
    const isMarkdown = n.toLowerCase().endsWith(".md");
    const abs = join(root.path, n);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return isMarkdown ? this.forget(root.id, n) : "rescan";
    }
    if (st.isDirectory()) return parts.at(-1)!.startsWith(".") || SKIP_DIRS.has(parts.at(-1)!) ? "ignored" : "rescan";
    if (!isMarkdown || parts.at(-1)!.startsWith(".")) return "ignored";
    if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_FILE_BYTES) return this.forget(root.id, n);
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      return this.forget(root.id, n);
    }
    // A symlinked parent folder would make this path point elsewhere; `scan` never follows those.
    if (real !== join(realpathSync(root.path), n)) return this.forget(root.id, n);
    return this.indexFile(root, n) === "indexed" ? "changed" : "unchanged";
  }

  private forget(rootId: string, rel: string): "changed" | "unchanged" {
    if (!this.db.prepare("select 1 from documents where id = ?").get(docId(rootId, rel))) return "unchanged";
    this.removeFile(rootId, rel);
    return "changed";
  }

  removeRoot(rootId: string): number {
    const rows = this.db.prepare("select rel_path from documents where root = ?").all(rootId) as Array<{ rel_path: string }>;
    for (const r of rows) this.removeFile(rootId, r.rel_path);
    return rows.length;
  }

  /** Incremental scan: index new/changed files, drop documents whose files disappeared. */
  scan(root: IndexRoot, onlyAreas?: string[]): IndexResult {
    const result: IndexResult = { indexed: 0, unchanged: 0, removed: 0, errors: [] };
    const plan = planScan(root.path);
    const present = new Set<string>();
    const known = new Map(
      (this.db.prepare("select rel_path, mtime_ms, hash from documents where root = ?").all(root.id) as Array<{ rel_path: string; mtime_ms: number }>).map(
        (r) => [r.rel_path, r.mtime_ms],
      ),
    );
    for (const rel of plan.read) {
      if (onlyAreas && root.id === "data" && !onlyAreas.includes(rel.split("/")[0] ?? "")) continue;
      present.add(rel);
      try {
        const st = statSync(join(root.path, rel));
        if (known.get(rel) === Math.floor(st.mtimeMs)) {
          result.unchanged++;
          continue;
        }
        if (this.indexFile(root, rel) === "indexed") result.indexed++;
        else result.unchanged++;
      } catch (e) {
        result.errors.push({ path: rel, error: (e as Error).message });
      }
    }
    for (const rel of known.keys()) {
      if (!present.has(rel)) {
        this.removeFile(root.id, rel);
        result.removed++;
      }
    }
    return result;
  }

  /** Drop the whole index and rebuild it from files. */
  rebuild(roots: IndexRoot[]): IndexResult {
    tx(this.db, () => {
      this.db.exec("delete from chunks_fts; delete from chunks; delete from documents;");
    });
    this.changed();
    const total: IndexResult = { indexed: 0, unchanged: 0, removed: 0, errors: [] };
    for (const root of roots) {
      const r = this.scan(root);
      total.indexed += r.indexed;
      total.unchanged += r.unchanged;
      total.errors.push(...r.errors);
    }
    return total;
  }
}
