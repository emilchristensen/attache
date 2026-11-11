import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Db, nowIso, json } from "../core/db.ts";
import { Indexer, planScan, type IndexRoot } from "./indexer.ts";
import { applyStateCorrection, appendHistory, parseMarkdown, parseStateEntries, removeStateEntry, renderMemoryDoc, slugify, splitFrontmatter } from "./markdown.ts";
import { assertWritable, isProtected, normalizeRel, resolveInside, type WriteActor, PolicyError } from "./policy.ts";
import { stringify as stringifyYaml } from "yaml";
import { redact } from "../core/log.ts";

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

export interface MemoryChange {
  id: string;
  /** Insertion order: a later change has a higher number, even within one millisecond. */
  seq: number;
  docRelPath: string;
  change: "create" | "correct" | "append" | "proposal" | "delete";
  subject: string | null;
  beforeValue: string | null;
  afterValue: string | null;
  reason: string | null;
  source: string | null;
  actor: string;
  status: "applied" | "proposed" | "rejected";
  createdAt: string;
  decidedAt: string | null;
  /** The Harness (integration kind) and session a save came from, when it came from one. */
  harness: string | null;
  sessionId: string | null;
  /** Shared by every change one save made, so a created note's own events do not block reverting it. */
  batchId: string | null;
  /** The change this one reverted. */
  reverts: string | null;
  /** SHA-256 of the note right after this change, to tell whether anything touched it since. */
  docHash: string | null;
}

/** Where a change came from, recorded with it in the change log. */
export interface ChangeMeta {
  harness?: string | null;
  sessionId?: string | null;
  batchId?: string | null;
  reverts?: string | null;
}

const README = `# Jarvis data folder

Jarvis keeps your knowledge here as plain Markdown. You can read and edit these files in any editor, including Obsidian.

- \`memory/\` is curated memory: people, projects, decisions and notes Jarvis recalls as knowledge.
  Each note has a \`## Current State\` section (one dated entry per subject, replaced on correction) and an append-only \`## History\`.
- \`evidence/\` is archived evidence: captures, conversation archives, coding-agent sessions and connector observations.
  Jarvis cites it but does not treat it as confirmed fact.
- \`deliverables/\` holds generated work products such as briefings, research results and drafts.

Search indexes are rebuilt from these files, so deleting the index never loses knowledge.
Service state (jobs, approvals, settings) and credentials live outside this folder.
`;

const today = () => new Date().toISOString().slice(0, 10);

export class MemoryStore {
  readonly indexer: Indexer;
  private lockFile: string | null = null;

  private readonly db: Db;
  private root: string | null;
  private readonly instance: string;

  constructor(db: Db, root: string | null, instance: string) {
    this.db = db;
    this.root = root;
    this.instance = instance;
    this.indexer = new Indexer(db);
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
    for (const d of ["memory/people", "memory/projects", "memory/decisions", "memory/notes", "evidence/captures", "evidence/conversations", "evidence/connectors", "evidence/sessions", "deliverables/briefings", "deliverables/research", "deliverables/drafts", ".jarvis"]) {
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
      const mine = ["memory", "evidence", "deliverables", ".jarvis", "README.md"].filter((e) => !before?.has(e));
      writeFileSync(owned, JSON.stringify({ createdFolder: !before || before.size === 0, created: mine, at: nowIso() }, null, 2));
    }
    this.acquireLock(root);
    this.releaseLockIfDifferent(root);
    this.root = root;
    return { created };
  }

  private acquireLock(root: string) {
    const lock = join(root, ".jarvis", "writer.lock");
    if (existsSync(lock)) {
      const owner = json<{ pid: number; instance: string }>(readFileSync(lock, "utf8"), { pid: 0, instance: "" });
      const alive = owner.pid > 0 && owner.pid !== process.pid && isAlive(owner.pid);
      if (alive && owner.instance !== this.instance) {
        throw new PolicyError(`Another Jarvis service (pid ${owner.pid}) owns this data folder`, "actor_denied");
      }
    }
    writeFileSync(lock, JSON.stringify({ pid: process.pid, instance: this.instance, at: nowIso() }));
  }

  private releaseLockIfDifferent(newRoot: string) {
    if (this.lockFile && this.lockFile !== join(newRoot, ".jarvis", "writer.lock")) this.releaseLock();
    this.lockFile = join(newRoot, ".jarvis", "writer.lock");
  }

  releaseLock() {
    if (!this.lockFile) return;
    try {
      const owner = json<{ pid: number }>(readFileSync(this.lockFile, "utf8"), { pid: 0 });
      if (owner.pid === process.pid) unlinkSync(this.lockFile);
    } catch {
      // Already gone.
    }
    this.lockFile = null;
  }

  close() {
    this.releaseLock();
    this.root = null;
  }

  // ---- low-level -----------------------------------------------------------

  read(rel: string): string {
    const abs = resolveInside(this.requireRoot(), rel);
    return readFileSync(abs, "utf8");
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
    writeFileSync(tmp, n.startsWith("memory/") ? content : redact(content));
    renameSync(tmp, abs);
    this.indexer.indexFile(this.rootRef!, n);
  }

  private uniquePath(dir: string, base: string): string {
    let rel = `${dir}/${base}.md`;
    let i = 2;
    while (this.exists(rel)) rel = `${dir}/${base}-${i++}.md`;
    return rel;
  }

  private recordChange(c: Omit<MemoryChange, "id" | "seq" | "createdAt" | "decidedAt" | keyof ChangeMeta | "docHash"> & { decidedAt?: string | null }, meta: ChangeMeta = {}): MemoryChange {
    const id = randomUUID();
    const docHash = c.status === "applied" && this.exists(c.docRelPath) ? noteHash(this.read(c.docRelPath)) : null;
    this.db
      .prepare(
        `insert into memory_changes (id, doc_rel_path, change, subject, before_value, after_value, reason, source, actor, status, created_at, decided_at, harness, session_id, batch_id, reverts, doc_hash)
         values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(id, c.docRelPath, c.change, c.subject, c.beforeValue, c.afterValue, c.reason, c.source, c.actor, c.status, nowIso(), c.decidedAt ?? (c.status === "applied" ? nowIso() : null), meta.harness ?? null, meta.sessionId ?? null, meta.batchId ?? null, meta.reverts ?? null, docHash);
    return this.getChange(id)!;
  }

  // ---- memory notes ----------------------------------------------------------

  createMemory(
    input: { type: MemoryType; title: string; state: Array<{ subject: string; value: string; date?: string; source?: SourceRef }>; notes?: string; sources?: SourceRef[]; provenance?: string; tags?: string[]; history?: string[] },
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
        created: today(),
        updated: today(),
        ...(input.tags?.length ? { tags: input.tags } : {}),
        sources: (input.sources ?? []).map(sourceToYaml),
      },
      title: input.title,
      state: input.state.map((s) => ({ subject: s.subject, date: s.date ?? today(), value: s.value, source: s.source ? formatSource(s.source) : sourceLabel })),
      ...(input.notes ? { notes: input.notes } : {}),
      history: [...(input.history ?? []).map((h) => (h.startsWith("- ") ? h : `- ${h}`)), `- ${today()} — created by ${actor}${input.provenance === "migrated" ? " (migrated, reviewed)" : ""}${sourceLabel ? ` from ${sourceLabel}` : ""}`],
    });
    this.writeFile(rel, doc, actor, opts);
    this.recordChange({ docRelPath: rel, change: "create", subject: null, beforeValue: null, afterValue: input.title, reason: null, source: sourceLabel ?? null, actor, status: "applied" }, meta);
    return { relPath: rel };
  }

  /**
   * Correct one current fact. The previous value is kept in History with its
   * date and source; the index is updated immediately so the next answer sees it.
   */
  correct(rel: string, input: { subject: string; value: string; reason: string; source?: SourceRef }, actor: WriteActor, opts: { confirmedProtected?: boolean; approvedProposal?: boolean } = {}, meta: ChangeMeta = {}): MemoryChange {
    const n = normalizeRel(rel);
    const raw = this.read(n);
    const sourceLabel = input.source ? formatSource(input.source) : actor === "user" ? "user correction" : undefined;
    const { text, previous } = applyStateCorrection(raw, { subject: input.subject, date: today(), value: input.value, source: sourceLabel }, input.reason || "corrected");
    const withUpdated = bumpFrontmatter(text, { updated: today() });
    this.writeFile(n, withUpdated, actor, opts);
    return this.recordChange({
      docRelPath: n,
      change: "correct",
      subject: input.subject,
      beforeValue: previous?.value ?? null,
      afterValue: input.value,
      reason: input.reason,
      source: sourceLabel ?? null,
      actor,
      status: "applied",
    }, meta);
  }

  /**
   * Take one subject out of Current State. The removed value is kept in History
   * with its date and source, as a correction keeps the value it replaces.
   */
  removeFact(rel: string, input: { subject: string; reason: string }, actor: WriteActor, meta: ChangeMeta = {}): MemoryChange {
    const n = normalizeRel(rel);
    const { text, removed } = removeStateEntry(this.read(n), { subject: input.subject, date: today() }, input.reason);
    if (!removed) throw new PolicyError(`${n} has no current “${input.subject}”`, "invalid_path");
    this.writeFile(n, bumpFrontmatter(text, { updated: today() }), actor);
    return this.recordChange({ docRelPath: n, change: "correct", subject: removed.subject, beforeValue: removed.value, afterValue: null, reason: input.reason, source: null, actor, status: "applied" }, meta);
  }

  appendEvent(rel: string, text: string, actor: WriteActor, meta: ChangeMeta = {}): void {
    const n = normalizeRel(rel);
    const raw = this.read(n);
    this.writeFile(n, appendHistory(raw, `- ${today()} — ${text.replace(/\s*\n\s*/g, " ")}`), actor);
    this.recordChange({ docRelPath: n, change: "append", subject: null, beforeValue: null, afterValue: text, reason: null, source: null, actor, status: "applied" }, meta);
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
    return this.recordChange({ docRelPath: n, change: "delete", subject: null, beforeValue: raw, afterValue: null, reason: input.reason, source: null, actor, status: "applied" }, meta);
  }

  /** Put a removed note back exactly as it was. */
  restoreMemory(rel: string, raw: string, input: { reason: string }, actor: WriteActor, meta: ChangeMeta = {}): MemoryChange {
    const n = normalizeRel(rel);
    if (this.exists(n)) throw new PolicyError(`${n} already exists`, "invalid_path");
    this.writeFile(n, raw, actor);
    return this.recordChange({ docRelPath: n, change: "create", subject: null, beforeValue: null, afterValue: parseMarkdown(raw, n).title, reason: input.reason, source: null, actor, status: "applied" }, meta);
  }

  /** Edit a note's free-text body (Notes section) as the user. */
  replaceNotes(rel: string, notes: string): void {
    const n = normalizeRel(rel);
    const raw = this.read(n);
    const lines = raw.split("\n");
    const start = lines.findIndex((l) => /^##\s+notes\s*$/i.test(l));
    let out: string;
    if (start >= 0) {
      let end = start + 1;
      while (end < lines.length && !/^##\s/.test(lines[end]!)) end++;
      out = [...lines.slice(0, start + 1), notes.trim(), "", ...lines.slice(end)].join("\n");
    } else {
      const hist = lines.findIndex((l) => /^##\s+history\s*$/i.test(l));
      const at = hist >= 0 ? hist : lines.length;
      out = [...lines.slice(0, at), "## Notes", notes.trim(), "", ...lines.slice(at)].join("\n");
    }
    this.writeFile(n, bumpFrontmatter(out, { updated: today() }), "user");
    this.recordChange({ docRelPath: n, change: "append", subject: "Notes", beforeValue: null, afterValue: notes.slice(0, 500), reason: "notes edited", source: null, actor: "user", status: "applied" });
  }

  // ---- proposals -----------------------------------------------------------------

  propose(input: { docRelPath: string | null; subject: string; value: string; reason: string; source: string; actor: WriteActor; newDoc?: { type: MemoryType; title: string } }): MemoryChange {
    return this.recordChange({
      docRelPath: input.docRelPath ?? `(new ${input.newDoc?.type ?? "note"}: ${input.newDoc?.title ?? input.subject})`,
      change: "proposal",
      subject: input.subject,
      beforeValue: null,
      afterValue: JSON.stringify({ value: input.value, newDoc: input.newDoc ?? null }),
      reason: input.reason,
      source: input.source,
      actor: input.actor,
      status: "proposed",
    });
  }

  decideProposal(id: string, decision: "apply" | "reject"): MemoryChange {
    const row = this.db.prepare("select * from memory_changes where id = ? and status = 'proposed'").get(id) as Record<string, string> | undefined;
    if (!row) throw new PolicyError("Proposal not found or already decided", "invalid_path");
    if (decision === "reject") {
      this.db.prepare("update memory_changes set status = 'rejected', decided_at = ? where id = ?").run(nowIso(), id);
      return this.getChange(id)!;
    }
    const payload = json<{ value: string; newDoc: { type: MemoryType; title: string } | null }>(row.after_value, { value: "", newDoc: null });
    const source: SourceRef = { kind: "user", ref: row.source ?? "proposal", observedAt: row.created_at!, label: row.source ?? undefined };
    if (payload.newDoc) {
      const { relPath } = this.createMemory({ type: payload.newDoc.type, title: payload.newDoc.title, state: [{ subject: row.subject!, value: payload.value }], sources: [source], provenance: "user-approved" }, "service", { approvedProposal: true });
      this.db.prepare("update memory_changes set status = 'applied', decided_at = ?, doc_rel_path = ? where id = ?").run(nowIso(), relPath, id);
    } else {
      if (isProtected(row.doc_rel_path!)) throw new PolicyError("Proposals cannot change protected records", "protected");
      this.correct(row.doc_rel_path!, { subject: row.subject!, value: payload.value, reason: row.reason ?? "approved proposal", source }, "service", { approvedProposal: true });
      this.db.prepare("update memory_changes set status = 'applied', decided_at = ? where id = ?").run(nowIso(), id);
    }
    return this.getChange(id)!;
  }

  getChange(id: string): MemoryChange | null {
    const r = this.db.prepare("select rowid as seq, * from memory_changes where id = ?").get(id) as Record<string, string | number | null> | undefined;
    return r ? rowToChange(r) : null;
  }

  /** Newest first. `after` keeps only changes recorded after the change with that `seq`. */
  listChanges(opts: { relPath?: string; status?: string; after?: number; limit?: number } = {}): MemoryChange[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (opts.relPath) {
      where.push("doc_rel_path = ?");
      args.push(opts.relPath);
    }
    if (opts.after !== undefined) {
      where.push("rowid > ?");
      args.push(opts.after);
    }
    if (opts.status) {
      where.push("status = ?");
      args.push(opts.status);
    }
    const rows = this.db
      .prepare(`select rowid as seq, * from memory_changes ${where.length ? "where " + where.join(" and ") : ""} order by rowid desc limit ${Math.min(opts.limit ?? 100, 500)}`)
      .all(...args) as Array<Record<string, string | number | null>>;
    return rows.map(rowToChange);
  }

  // ---- captures, evidence, deliverables -----------------------------------------------

  capture(input: { text: string; title?: string; source: SourceRef; tags?: string[] }, actor: WriteActor = "user"): { relPath: string } {
    const title = input.title?.trim() || firstWords(input.text);
    const rel = this.uniquePath("evidence/captures", `${today()}-${slugify(title)}`);
    const fm = { id: randomUUID(), type: "capture", title, captured_at: nowIso(), provenance: "captured", source: sourceToYaml(input.source), ...(input.tags?.length ? { tags: input.tags } : {}) };
    const quoted = input.text
      .trim()
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    const body = `---\n${stringifyYaml(fm, { lineWidth: 0 }).trimEnd()}\n---\n# ${title}\n\n${quoted}\n\nSource: ${formatSource(input.source)}\n`;
    this.writeFile(rel, body, actor === "user" ? "user" : "connector");
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
      const content = readFileSync(join(input.path, rel), "utf8");
      const target = `${base}/${rel}`;
      const hash = createHash("sha256").update(content).digest("hex");
      if (this.exists(target) && createHash("sha256").update(this.read(target)).digest("hex") === hash) unchanged++;
      else {
        this.writeFile(target, content, "user");
        written++;
      }
      rows.push(`| ${rel} | ${Buffer.byteLength(content)} | ${hash.slice(0, 16)} |`);
    }
    const origin = input.origin ?? input.path;
    const fm = { type: "archive", title: `Archive of ${origin}`, source_path: input.path, ...(input.origin ? { origin: input.origin } : {}), archived_at: nowIso(), files: rows.length, excluded: input.exclude, provenance: "archived-verbatim" };
    const manifest = `---\n${stringifyYaml(fm, { lineWidth: 0 }).trimEnd()}\n---\n# Archive of ${origin}\n\nVerbatim copies of ${rows.length} Markdown files, at the same relative paths, so citations keep their line numbers.\n\n| File | Bytes | SHA-256 (first 16) |\n| --- | --- | --- |\n${rows.join("\n")}\n`;
    this.writeFile(`${base}/ARCHIVE.md`, manifest, "user");
    return { relPath: `${base}/ARCHIVE.md`, written, unchanged, excluded: skipped, files: rows.length };
  }

  /** A source-linked decision: curated memory that cites the evidence it came from. */
  recordDecision(input: { title: string; decision: string; rationale?: string; source: SourceRef; project?: string }, actor: WriteActor = "user"): { relPath: string } {
    const state = [{ subject: "Decision", value: input.decision }];
    if (input.project) state.push({ subject: "Project", value: input.project });
    return this.createMemory({ type: "decision", title: input.title, state, ...(input.rationale ? { notes: input.rationale } : {}), sources: [input.source], provenance: "user-stated" }, actor);
  }

  writeDeliverable(kind: "briefings" | "research" | "drafts", title: string, body: string, meta: Record<string, unknown> = {}): { relPath: string } {
    const rel = this.uniquePath(`deliverables/${kind}`, `${today()}-${slugify(title)}`);
    const fm = { id: randomUUID(), type: kind.replace(/s$/, ""), title, generated_at: nowIso(), provenance: "generated", ...meta };
    this.writeFile(rel, `---\n${stringifyYaml(fm, { lineWidth: 0 }).trimEnd()}\n---\n# ${title}\n\n${body.trim()}\n`, "service");
    return { relPath: rel };
  }

  archiveConversation(conversationId: string, title: string, messages: Array<{ role: string; content: string; at: string }>): { relPath: string } {
    const rel = `evidence/conversations/${conversationId}.md`;
    const fm = { id: conversationId, type: "conversation", title, archived_at: nowIso(), provenance: "conversation-archive" };
    const body = messages.map((m) => `### ${m.role} · ${m.at}\n\n${m.content.trim()}`).join("\n\n");
    this.writeFile(rel, `---\n${stringifyYaml(fm, { lineWidth: 0 }).trimEnd()}\n---\n# ${title}\n\n${body}\n`, "service");
    return { relPath: rel };
  }

  /**
   * The conversation of one coding-agent session. Rewritten as the session
   * grows (compaction, then the end), so one session is always one file.
   */
  archiveAgentSession(rel: string, meta: { agent: string; agentLabel: string; sessionId: string; title: string; cwd: string | null; startedAt: string | null }, turns: Array<{ role: "user" | "assistant"; text: string; at: string | null }>, userName: string): { relPath: string } {
    const fm = { id: meta.sessionId, type: "agent-session", title: meta.title, agent: meta.agent, cwd: meta.cwd, started_at: meta.startedAt, archived_at: nowIso(), provenance: "agent-session-archive" };
    const body = turns.map((t) => `### ${t.role === "user" ? userName : meta.agentLabel}${t.at ? ` · ${t.at}` : ""}\n\n${t.text.trim()}`).join("\n\n");
    const where = [meta.agentLabel, meta.cwd ? `in \`${meta.cwd}\`` : null, meta.startedAt ? `started ${meta.startedAt}` : null].filter(Boolean).join(" · ");
    this.writeFile(rel, `---\n${stringifyYaml(fm, { lineWidth: 0 }).trimEnd()}\n---\n# ${meta.title}\n\n${where}\n\n${body}\n`, "service");
    return { relPath: rel };
  }

  /** Append one section to the session log for `date` (YYYY-MM-DD), creating the day's file when needed. */
  appendSessionLog(date: string, section: string): { relPath: string } {
    const rel = `evidence/sessions/${date}.md`;
    const head = `---\n${stringifyYaml({ type: "session-log", title: `Agent sessions on ${date}`, date, provenance: "agent-session-summary" }, { lineWidth: 0 }).trimEnd()}\n---\n# Agent sessions on ${date}\n`;
    const existing = this.exists(rel) ? this.read(rel).trimEnd() : head.trimEnd();
    this.writeFile(rel, `${existing}\n\n${section.trim()}\n`, "service");
    return { relPath: rel };
  }

  /** Daily evidence snapshot of what a connector observed, so recall can cite it. */
  writeConnectorSnapshot(kind: string, label: string, lines: string[]): { relPath: string } {
    const rel = `evidence/connectors/${slugify(kind)}/${today()}.md`;
    const fm = { type: "connector-snapshot", title: `${label} on ${today()}`, source: kind, observed_at: nowIso(), provenance: "connector" };
    const body = lines.length ? lines.join("\n") : "_The last sync returned no items._";
    this.writeFile(rel, `---\n${stringifyYaml(fm, { lineWidth: 0 }).trimEnd()}\n---\n# ${label} on ${today()}\n\nLatest observation at ${nowIso()}.\n\n${body}\n`, "connector");
    return { relPath: rel };
  }

  /** Protected identity record; only an explicit user settings action writes it. */
  writeIdentity(input: { name: string; email?: string; role?: string; notes?: string }, confirmed: boolean): { relPath: string } {
    const rel = "memory/self.md";
    const doc = renderMemoryDoc({
      frontmatter: { id: "self", type: "person", title: input.name, provenance: "user-stated", protected: true, updated: today() },
      title: input.name,
      state: [
        { subject: "Name", date: today(), value: input.name },
        ...(input.email ? [{ subject: "Email", date: today(), value: input.email }] : []),
        ...(input.role ? [{ subject: "Role", date: today(), value: input.role }] : []),
      ],
      ...(input.notes ? { notes: input.notes } : {}),
      history: [`- ${today()} — identity set from Settings`],
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

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function firstWords(text: string): string {
  const words = text.replace(/[#>*_`]/g, " ").trim().split(/\s+/).slice(0, 8).join(" ");
  return words || "Capture";
}

export function formatSource(s: SourceRef): string {
  const lines = s.lines ? `#L${s.lines[0]}-L${s.lines[1]}` : "";
  const where = s.url ?? `${s.root && s.root !== "data" ? s.root + ":" : ""}${s.ref}${lines}`;
  return `${s.label ? s.label + " " : ""}(${s.kind}: ${where}, observed ${s.observedAt.slice(0, 10)})`;
}

function sourceToYaml(s: SourceRef): Record<string, unknown> {
  return { kind: s.kind, ref: s.ref, ...(s.root ? { root: s.root } : {}), ...(s.lines ? { lines: s.lines } : {}), ...(s.url ? { url: s.url } : {}), observed_at: s.observedAt, ...(s.label ? { label: s.label } : {}) };
}

function bumpFrontmatter(raw: string, patch: Record<string, unknown>): string {
  const { frontmatter, body } = splitFrontmatter(raw);
  if (!Object.keys(frontmatter).length) return raw;
  return `---\n${stringifyYaml({ ...frontmatter, ...patch }, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}

/** Fingerprint of a note's text, comparable with `MemoryChange.docHash`. */
export function noteHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function rowToChange(raw: Record<string, string | number | null>): MemoryChange {
  const r = raw as Record<string, string | null>;
  return {
    id: r.id!,
    seq: Number(raw.seq),
    docRelPath: r.doc_rel_path!,
    change: r.change as MemoryChange["change"],
    subject: r.subject ?? null,
    beforeValue: r.before_value ?? null,
    afterValue: r.after_value ?? null,
    reason: r.reason ?? null,
    source: r.source ?? null,
    actor: r.actor!,
    status: r.status as MemoryChange["status"],
    createdAt: r.created_at!,
    decidedAt: r.decided_at ?? null,
    harness: r.harness ?? null,
    sessionId: r.session_id ?? null,
    batchId: r.batch_id ?? null,
    reverts: r.reverts ?? null,
    docHash: r.doc_hash ?? null,
  };
}
