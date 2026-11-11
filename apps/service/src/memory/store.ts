import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type Db, json, nowIso, tx } from "../core/db.ts";
import { redact } from "../core/log.ts";
import type { MachineIdentity } from "../core/machine.ts";
import { replaceWith } from "../platform/replace-file.ts";
import { REVIEW_STATE_DIR } from "../review-state/files.ts";
import { ChangeLog, type ChangeMeta, type ListChangesOptions, type MemoryChange, type NewChange } from "./change-log.ts";
import { agentSessionFile, archiveManifest, captureFile, captureTitle, connectorSnapshotFile, deliverableFile, formatSource, oneLine, sourceToYaml, sessionLogHead, withFrontmatter, wrapUpFile, type AgentSessionMeta } from "./evidence-files.ts";
import { connectorSnapshotPath, deliverableName, sessionLogPath, wrapUpPath } from "./evidence-paths.ts";
import { Indexer, planScan, type IndexRoot } from "./indexer.ts";
import { applyStateCorrection, appendHistory, parseMarkdown, parseStateEntries, removeStateEntry, renderMemoryDoc, slugify, splitFrontmatter, toLf } from "./markdown.ts";
import { assertWritable, isProtected, normalizeRel, resolveInside, type WriteActor, PolicyError } from "./policy.ts";
import { factDay } from "./review-date.ts";
import { WriterLock } from "./writer-lock.ts";

/** Kept here as well, where callers have always imported them from. */
export type { ChangeMeta, MemoryChange } from "./change-log.ts";
export { formatSource } from "./evidence-files.ts";

export const MEMORY_TYPES = ["person", "project", "decision", "note"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface SourceRef {
  kind: "capture" | "note" | "import" | "connector" | "conversation" | "user" | "agent-session";
  /** Relative path inside a root, or an external URL. */
  ref: string;
  root?: string;
  lines?: [number, number];
  url?: string;
  observedAt: string;
  label?: string;
}

export interface IndexedDocument {
  id: string;
  root: string;
  relPath: string;
  area: string;
  docType: string | null;
  title: string;
  meta: Record<string, unknown>;
  indexedAt: string;
  mtimeMs: number;
}

const README = `# Jarvis data folder

Jarvis keeps your knowledge here as plain Markdown. You can read and edit these files in any editor, including Obsidian.

- \`memory/\` is curated memory: people, projects, decisions and notes Jarvis recalls as knowledge.
  Each note has a \`## Current State\` section (one dated entry per subject, replaced on correction) and an append-only \`## History\`.
- \`evidence/\` is archived evidence: captures, Harness sessions and connector observations (and chat archives from earlier versions).
  Jarvis cites it but does not treat it as confirmed fact.
- \`deliverables/\` holds generated work products such as briefings, research results and drafts.
- \`review/\` holds what waits for your decision: the inbox (with its dismiss and snooze decisions) and Proposals, one small JSON file per item, so every Machine shows the same.
  It is Jarvis's own bookkeeping in JSON and is never searched.

Search indexes are rebuilt from these files, so deleting the index never loses knowledge.
Service state (jobs, approvals, settings) and credentials live outside this folder.
`;

export interface MemoryStoreOptions {
  /** Install name; a live service of another instance on the same folder is refused. */
  instance: string;
  /** Where writer locks live, outside every data folder. */
  locksDir: string;
  /** The Machine this service runs on, read at each write so a rename applies at once. */
  machine: () => MachineIdentity;
  /** Told after every file the store writes or removes, e.g. so Replication commits it. */
  onWrite?: (relPath: string) => void;
  /** The time the store dates facts, History lines and files by; the system clock unless given. */
  now?: () => Date;
}

export class MemoryStore {
  readonly indexer: Indexer;
  private readonly changes: ChangeLog;
  private lock: WriterLock | null = null;

  private readonly db: Db;
  private root: string | null;
  private readonly opts: MemoryStoreOptions;

  constructor(db: Db, root: string | null, opts: MemoryStoreOptions) {
    this.db = db;
    this.root = root;
    this.opts = opts;
    this.indexer = new Indexer(db);
    this.changes = new ChangeLog(db);
  }

  /** The store's clock: the service clock when the App gives one, else the system clock. */
  now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /** Today's day (`YYYY-MM-DD`) by the store's clock: the date a new fact or History line gets. */
  today(): string {
    return factDay(this.now());
  }

  get dataRoot(): string | null {
    return this.root;
  }

  get rootRef(): IndexRoot | null {
    return this.root ? { id: "data", path: this.root, label: "Jarvis data folder" } : null;
  }

  private requireRoot(): string {
    if (!this.root) throw new PolicyError("No data folder is configured", "invalid_path");
    return this.root;
  }

  /** Create the folder layout (if needed) and take the single-writer lock. */
  open(root: string): { created: string[] } {
    const created: string[] = [];
    const before = existsSync(root) ? new Set(readdirSync(root).filter((f) => f !== ".DS_Store")) : null;
    mkdirSync(root, { recursive: true });
    for (const d of ["memory/people", "memory/projects", "memory/decisions", "memory/notes", "evidence/captures", "evidence/connectors", "evidence/sessions", "deliverables/briefings", "deliverables/research", "deliverables/drafts", ".jarvis"]) {
      const abs = join(root, d);
      if (!existsSync(abs)) {
        mkdirSync(abs, { recursive: true });
        created.push(d + "/");
      }
    }
    if (!existsSync(join(root, "README.md"))) {
      writeFileSync(join(root, "README.md"), README);
      created.push("README.md");
    }
    // Record what Jarvis created, so a data-deleting uninstall never removes files the user already had.
    const owned = join(root, ".jarvis", "owned.json");
    if (!existsSync(owned)) {
      const mine = ["memory", "evidence", "deliverables", REVIEW_STATE_DIR, ".jarvis", "README.md"].filter((e) => !before?.has(e));
      writeFileSync(owned, JSON.stringify({ createdFolder: !before || before.size === 0, created: mine, at: nowIso() }, null, 2));
    }
    this.takeLock(root);
    this.root = root;
    return { created };
  }

  /** Hold the writer lock on `root`, and let go of the one on the previous folder. */
  private takeLock(root: string) {
    if (this.lock?.covers(root)) return;
    const next = WriterLock.acquire(root, { instance: this.opts.instance, locksDir: this.opts.locksDir });
    this.lock?.release();
    this.lock = next;
  }

  releaseLock() {
    this.lock?.release();
    this.lock = null;
  }

  close() {
    this.releaseLock();
    this.root = null;
  }

  // ---- low-level -----------------------------------------------------------

  /** A file's text, with LF line endings however an editor saved it. */
  read(rel: string): string {
    const abs = resolveInside(this.requireRoot(), rel);
    return toLf(readFileSync(abs, "utf8"));
  }

  exists(rel: string): boolean {
    try {
      return existsSync(resolveInside(this.requireRoot(), rel));
    } catch {
      return false;
    }
  }

  private writeFile(rel: string, content: string, actor: WriteActor, opts: { confirmedProtected?: boolean; approvedProposal?: boolean } = {}) {
    const n = normalizeRel(rel);
    assertWritable(n, actor, opts);
    const abs = resolveInside(this.requireRoot(), n);
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = join(dirname(abs), `.${randomUUID()}.tmp`);
    // Archived evidence and generated deliverables never keep credentials that appeared in sources.
    // Everything Jarvis writes is LF, whatever line breaks the text arrived with, so every Machine holds the same bytes.
    const text = toLf(content);
    writeFileSync(tmp, n.startsWith("memory/") ? text : redact(text));
    replaceWith(tmp, abs);
    this.indexer.indexFile(this.rootRef!, n);
    this.opts.onWrite?.(n);
  }

  private uniquePath(dir: string, base: string): string {
    let rel = `${dir}/${base}.md`;
    let i = 2;
    while (this.exists(rel)) rel = `${dir}/${base}-${i++}.md`;
    return rel;
  }

  private recordChange(
    c: NewChange,
    meta: ChangeMeta = {},
  ): MemoryChange {
    const docHash = c.status === "applied" && this.exists(c.docRelPath) ? noteHash(this.read(c.docRelPath)) : null;
    return this.changes.record(c, meta, docHash);
  }

  // ---- memory notes ----------------------------------------------------------

  createMemory(
    input: { type: MemoryType; title: string; state: Array<{ subject: string; value: string; date?: string; review?: string; source?: SourceRef }>; notes?: string; sources?: SourceRef[]; provenance?: string; tags?: string[]; history?: string[]; events?: string[] },
    actor: WriteActor,
    opts: { approvedProposal?: boolean } = {},
    meta: ChangeMeta = {},
  ): { relPath: string } {
    const dir = `memory/${input.type === "person" ? "people" : input.type + "s"}`;
    const rel = this.uniquePath(dir, slugify(input.title));
    const sourceLabel = input.sources?.[0] ? formatSource(input.sources[0]) : undefined;
    const doc = renderMemoryDoc({
      frontmatter: {
        id: randomUUID(),
        type: input.type,
        title: input.title,
        provenance: input.provenance ?? (actor === "user" ? "user-stated" : "inferred"),
        created: this.today(),
        updated: this.today(),
        ...(input.tags?.length ? { tags: input.tags } : {}),
        sources: (input.sources ?? []).map(sourceToYaml),
      },
      title: input.title,
      state: input.state.map((s) => ({ subject: s.subject, date: s.date ?? this.today(), review: s.review, value: s.value, source: s.source ? formatSource(s.source) : sourceLabel })),
      ...(input.notes ? { notes: input.notes } : {}),
      history: [
        ...(input.history ?? []).map((h) => (h.startsWith("- ") ? h : `- ${h}`)),
        `- ${this.today()} — created by ${actor}${input.provenance === "migrated" ? " (migrated, reviewed)" : ""}${sourceLabel ? ` from ${sourceLabel}` : ""}`,
        ...(input.events ?? []).map((e) => eventLine(this.today(), e)),
      ],
    });
    this.writeFile(rel, doc, actor, opts);
    tx(this.db, () => {
      this.recordChange({ docRelPath: rel, change: "create", subject: null, beforeValue: null, afterValue: input.title, reason: null, source: sourceLabel ?? null, actor, status: "applied" }, meta);
      for (const e of input.events ?? []) this.recordChange({ docRelPath: rel, change: "append", subject: null, beforeValue: null, afterValue: e, reason: null, source: sourceLabel ?? null, actor, status: "applied" }, meta);
    });
    return { relPath: rel };
  }

  /**
   * Correct one current fact. The previous value is kept in History with its
   * date and source; the index is updated immediately so the next answer sees it.
   */
  correct(
    rel: string,
    input: { subject: string; value: string; reason: string; review?: string | null | undefined; source?: SourceRef },
    actor: WriteActor,
    opts: { confirmedProtected?: boolean; approvedProposal?: boolean } = {},
    meta: ChangeMeta = {},
  ): MemoryChange {
    const { subject, value, reason, review, source } = input;
    return this.update(rel, { facts: [{ subject, value, reason, ...(review ? { review } : {}) }], events: [], ...(source ? { source } : {}) }, actor, opts, meta)[0]!;
  }

  /**
   * Correct several facts and append several events to one note in a single
   * write, so either every part lands or none does. Each superseded value
   * moves to History with its date and source.
   */
  update(
    rel: string,
    input: { facts: Array<{ subject: string; value: string; reason: string; review?: string | undefined }>; events: string[]; source?: SourceRef },
    actor: WriteActor,
    opts: { confirmedProtected?: boolean; approvedProposal?: boolean } = {},
    meta: ChangeMeta = {},
  ): MemoryChange[] {
    const n = normalizeRel(rel);
    const sourceLabel = input.source ? formatSource(input.source) : actor === "user" ? "user correction" : undefined;
    let text = this.read(n);
    const corrections: Array<{ subject: string; before: string | null; beforeReview: string | null; value: string; review: string | null; reason: string }> = [];
    for (const f of input.facts) {
      const out = applyStateCorrection(text, { subject: f.subject, date: this.today(), review: f.review, value: f.value, source: sourceLabel }, f.reason || "corrected");
      text = out.text;
      corrections.push({ subject: f.subject, before: out.previous?.value ?? null, beforeReview: out.previous?.review ?? null, value: f.value, review: f.review ?? null, reason: f.reason });
    }
    for (const e of input.events) text = appendHistory(text, eventLine(this.today(), e));
    this.writeFile(n, input.facts.length ? bumpFrontmatter(text, { updated: this.today() }) : text, actor, opts);
    return tx(this.db, () => [
      ...corrections.map((c) => this.recordChange({ docRelPath: n, change: "correct", subject: c.subject, beforeValue: c.before, afterValue: c.value, beforeReview: c.beforeReview, afterReview: c.review, reason: c.reason, source: sourceLabel ?? null, actor, status: "applied" }, meta)),
      ...input.events.map((e) => this.recordChange({ docRelPath: n, change: "append", subject: null, beforeValue: null, afterValue: e, reason: null, source: input.source ? formatSource(input.source) : null, actor, status: "applied" }, meta)),
    ]);
  }

  appendEvent(rel: string, text: string, actor: WriteActor, meta: ChangeMeta = {}): void {
    this.update(rel, { facts: [], events: [text] }, actor, {}, meta);
  }

  /**
   * Take one subject out of Current State. The removed value is kept in History
   * with its date and source, as a correction keeps the value it replaces.
   */
  removeFact(rel: string, input: { subject: string; reason: string }, actor: WriteActor, meta: ChangeMeta = {}): MemoryChange {
    const n = normalizeRel(rel);
    const { text, removed } = removeStateEntry(this.read(n), { subject: input.subject, date: this.today() }, input.reason);
    if (!removed) throw new PolicyError(`${n} has no current “${input.subject}”`, "invalid_path");
    this.writeFile(n, bumpFrontmatter(text, { updated: this.today() }), actor);
    return this.recordChange({ docRelPath: n, change: "correct", subject: removed.subject, beforeValue: removed.value, afterValue: null, beforeReview: removed.review ?? null, reason: input.reason, source: null, actor, status: "applied" }, meta);
  }

  /**
   * Remove a curated note from the Brain and from search. The change log keeps
   * the whole file, so the removal itself can be undone.
   */
  deleteMemory(rel: string, input: { reason: string }, actor: WriteActor, meta: ChangeMeta = {}): MemoryChange {
    const n = normalizeRel(rel);
    if (!n.startsWith("memory/")) throw new PolicyError(`Only curated memory notes can be removed: ${n}`, "invalid_path");
    assertWritable(n, actor);
    const raw = this.read(n);
    unlinkSync(resolveInside(this.requireRoot(), n));
    this.indexer.removeFile(this.rootRef!.id, n);
    this.opts.onWrite?.(n);
    return this.recordChange({ docRelPath: n, change: "delete", subject: null, beforeValue: raw, afterValue: null, reason: input.reason, source: null, actor, status: "applied" }, meta);
  }

  /** Put a removed note back exactly as it was. */
  restoreMemory(rel: string, raw: string, input: { reason: string }, actor: WriteActor, meta: ChangeMeta = {}): MemoryChange {
    const n = normalizeRel(rel);
    if (this.exists(n)) throw new PolicyError(`${n} already exists`, "invalid_path");
    this.writeFile(n, raw, actor);
    return this.recordChange({ docRelPath: n, change: "create", subject: null, beforeValue: null, afterValue: parseMarkdown(raw, n).title, reason: input.reason, source: null, actor, status: "applied" }, meta);
  }

  // ---- Proposals kept in the change log before they moved into the Brain -------------

  /** Proposals this Machine stored in its change log before Proposals became files in the Brain, oldest first. */
  legacyProposals(): MemoryChange[] {
    return this.changes.legacyProposals();
  }

  /** Drop change-log Proposals once they are files in the Brain. */
  forgetLegacyProposals(ids: readonly string[]): void {
    this.changes.forgetLegacyProposals(ids);
  }

  /** Every change one save or approval made, newest first. */
  changesInBatch(batchId: string): MemoryChange[] {
    return this.changes.inBatch(batchId);
  }

  getChange(id: string): MemoryChange | null {
    return this.changes.get(id);
  }

  /** Newest first. `after` keeps only changes recorded after the change with that `seq`. */
  listChanges(opts: ListChangesOptions = {}): MemoryChange[] {
    return this.changes.list(opts);
  }

  // ---- captures, evidence, deliverables -----------------------------------------------

  capture(input: { text: string; title?: string; source: SourceRef; tags?: string[] }, actor: WriteActor = "user"): { relPath: string } {
    const title = captureTitle(input.text, input.title);
    const rel = this.uniquePath("evidence/captures", `${this.today()}-${slugify(title)}`);
    this.writeFile(rel, captureFile({ ...input, title }), actor === "user" ? "user" : "connector");
    return { relPath: rel };
  }

  /**
   * Copy a folder's Markdown files verbatim into evidence/archive/<label>/, keeping
   * their paths so line numbers cited by migrated memory stay exact once the
   * original is gone. Re-running updates changed files only. ARCHIVE.md records
   * the origin and a hash per file.
   */
  archiveFolder(input: { path: string; label: string; exclude: string[]; origin?: string }): { relPath: string; written: number; unchanged: number; excluded: number; files: number } {
    const plan = planScan(input.path);
    const excluded = (rel: string) => input.exclude.some((e) => rel === e || rel.startsWith(e.endsWith("/") ? e : `${e}/`));
    const base = `evidence/archive/${input.label}`;
    const rows: string[] = [];
    let written = 0;
    let unchanged = 0;
    let skipped = 0;
    for (const rel of plan.read) {
      if (excluded(rel)) {
        skipped++;
        continue;
      }
      const content = toLf(readFileSync(join(input.path, rel), "utf8"));
      const target = `${base}/${rel}`;
      const hash = createHash("sha256").update(content).digest("hex");
      if (this.exists(target) && createHash("sha256").update(this.read(target)).digest("hex") === hash) unchanged++;
      else {
        this.writeFile(target, content, "user");
        written++;
      }
      rows.push(`| ${rel} | ${Buffer.byteLength(content)} | ${hash.slice(0, 16)} |`);
    }
    this.writeFile(`${base}/ARCHIVE.md`, archiveManifest({ ...input, rows }), "user");
    return { relPath: `${base}/ARCHIVE.md`, written, unchanged, excluded: skipped, files: rows.length };
  }

  writeDeliverable(kind: "briefings" | "research" | "drafts", title: string, body: string, meta: Record<string, unknown> = {}): { relPath: string } {
    const rel = this.uniquePath(`deliverables/${kind}`, deliverableName(this.today(), title, this.opts.machine()));
    this.writeFile(rel, deliverableFile(kind, title, body, meta), "service");
    return { relPath: rel };
  }

  /**
   * The conversation of one Harness session. Rewritten as the session
   * grows (compaction, then the end), so one session is always one file.
   */
  archiveAgentSession(rel: string, meta: AgentSessionMeta, turns: Array<{ role: "user" | "assistant"; text: string; at: string | null }>, userName: string): { relPath: string } {
    this.writeFile(rel, agentSessionFile(meta, turns, userName), "service");
    return { relPath: rel };
  }

  /** Append one section to the session log for `date` (YYYY-MM-DD), creating the day's file when needed. */
  appendSessionLog(date: string, section: string): { relPath: string } {
    const machine = this.opts.machine();
    const rel = sessionLogPath(date, machine);
    const existing = this.exists(rel) ? this.read(rel).trimEnd() : sessionLogHead(date, machine).trimEnd();
    this.writeFile(rel, `${existing}\n\n${section.trim()}\n`, "service");
    return { relPath: rel };
  }

  /** Daily evidence snapshot of what a connector observed, so recall can cite it. */
  writeConnectorSnapshot(kind: string, label: string, lines: string[]): { relPath: string } {
    const machine = this.opts.machine();
    const rel = connectorSnapshotPath(kind, this.today(), machine);
    this.writeFile(rel, connectorSnapshotFile({ kind, label, day: this.today(), machine, lines }), "connector");
    return { relPath: rel };
  }

  /**
   * The durable points of one Harness conversation, as its agent summed them
   * up. Evidence, not curated memory: the points sit in the body, never under
   * Current State, so recall never offers one as a current fact.
   */
  recordWrapUp(input: { harness: { id: string; label: string }; title: string; points: string[] }): { relPath: string; title: string; date: string } {
    const machine = this.opts.machine();
    const date = this.today();
    // Redacted before it names the file: the write redacts only the content.
    const title = redact(oneLine(input.title));
    const planned = wrapUpPath(date, title, machine);
    const rel = this.uniquePath(dirname(planned), basename(planned, ".md"));
    this.writeFile(rel, wrapUpFile({ harness: input.harness, title, date, machine, points: input.points }), "service");
    return { relPath: rel, title, date };
  }

  /** Protected identity record; only an explicit user settings action writes it. */
  writeIdentity(input: { name: string; email?: string; role?: string; notes?: string }, confirmed: boolean): { relPath: string } {
    const rel = "memory/self.md";
    const doc = renderMemoryDoc({
      frontmatter: { id: "self", type: "person", title: input.name, provenance: "user-stated", protected: true, updated: this.today() },
      title: input.name,
      state: [
        { subject: "Name", date: this.today(), value: input.name },
        ...(input.email ? [{ subject: "Email", date: this.today(), value: input.email }] : []),
        ...(input.role ? [{ subject: "Role", date: this.today(), value: input.role }] : []),
      ],
      ...(input.notes ? { notes: input.notes } : {}),
      history: [`- ${this.today()} — identity set from Settings`],
    });
    this.writeFile(rel, doc, "user", { confirmedProtected: confirmed });
    return { relPath: rel };
  }

  listDocuments(opts: { area?: string; docType?: string; root?: string; limit?: number } = {}): IndexedDocument[] {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.area) {
      where.push("area = ?");
      args.push(opts.area);
    }
    if (opts.docType) {
      where.push("doc_type = ?");
      args.push(opts.docType);
    }
    if (opts.root) {
      where.push("root = ?");
      args.push(opts.root);
    }
    return this.db
      .prepare(
        `select id, root, rel_path as relPath, area, doc_type as docType, title, meta, indexed_at as indexedAt, mtime_ms as mtimeMs from documents ${where.length ? "where " + where.join(" and ") : ""} order by mtime_ms desc limit ${Math.min(opts.limit ?? 200, 2000)}`,
      )
      .all(...args)
      .map((r) => {
        const row = r as Omit<IndexedDocument, "meta"> & { meta: string };
        return { ...row, meta: json<Record<string, unknown>>(row.meta, {}) };
      });
  }

  describe(rel: string) {
    const raw = this.read(rel);
    const parsed = parseMarkdown(raw, rel);
    return { relPath: normalizeRel(rel), raw, frontmatter: parsed.frontmatter, title: parsed.title, state: parseStateEntries(raw), protected: isProtected(normalizeRel(rel)) };
  }

  listFiles(dir: string): string[] {
    const abs = resolveInside(this.requireRoot(), dir);
    if (!existsSync(abs)) return [];
    return readdirSync(abs).filter((f) => f.endsWith(".md"));
  }
}


/** A History line for an event that happened today. */
function eventLine(day: string, text: string): string {
  return `- ${day} — ${text.replace(/\s*\n\s*/g, " ")}`;
}

function bumpFrontmatter(raw: string, patch: Record<string, unknown>): string {
  const { frontmatter, body } = splitFrontmatter(raw);
  if (!Object.keys(frontmatter).length) return raw;
  return withFrontmatter({ ...frontmatter, ...patch }, body);
}

/** Fingerprint of a note's text, comparable with `MemoryChange.docHash`. */
export function noteHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

