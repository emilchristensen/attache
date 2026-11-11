import { join } from "node:path";
import type { MemoryAuditEntry, MemoryAuditReport } from "@jarvis/contracts";
import type { App } from "../app.ts";
import { nowIso } from "../core/db.ts";
import { notesInSessionContext } from "../agents/project-notes.ts";
import { brainNote, type BrainNote } from "./note-links.ts";
import { parseStateEntries, parseStateLine, slugify, type StateEntry } from "./markdown.ts";
import { isPastReview } from "./review-date.ts";
import { RECALL_EXCLUDE, queryTerms, search, termCoverage, type SearchHit } from "./search.ts";

const EVIDENCE_PER_ENTRY = 3;
const DAY_MS = 86_400_000;

/** `label (kind: where, observed date)`, the shape `formatSource` writes. */
const SOURCE_RE = /\((capture|note|import|connector|conversation|user|agent-session): (.+?), observed \d{4}-\d{2}-\d{2}\)$/;
const LOCAL_KINDS = new Set(["capture", "note", "conversation", "agent-session"]);

/**
 * The deterministic half of a memory audit: every current fact in curated
 * memory with its age, source and the newer documents that mention its note.
 * It counts and flags; judging whether newer evidence contradicts a fact is
 * left to whoever reads the report. A fact is stale only when it is past its
 * Review date: age alone says nothing about whether it still holds. Read-only.
 */
export function auditMemory(app: App, opts: { now?: Date } = {}): MemoryAuditReport {
  const root = app.memory.dataRoot;
  if (!root) throw new Error("Choose a data folder first");
  const now = opts.now ?? new Date();
  const docs = app.memory.listDocuments({ area: "memory", root: "data", limit: 2000 }).filter((d) => d.relPath !== "memory/self.md");
  const read: Array<Omit<MemoryAuditReport["findings"][number], "inSessionIndex">> = [];
  const notes: BrainNote[] = [];
  for (const d of docs) {
    let raw: string;
    try {
      raw = app.memory.read(d.relPath);
    } catch {
      continue;
    }
    const state = parseStateEntries(raw);
    if (d.title) notes.push(brainNote({ relPath: d.relPath, type: d.docType ?? "note", title: d.title }, raw));
    const subjects = new Map<string, number>();
    for (const s of state) subjects.set(s.subject.toLowerCase(), (subjects.get(s.subject.toLowerCase()) ?? 0) + 1);
    const entries = state.map((s) => auditEntry(app, s, now, (subjects.get(s.subject.toLowerCase()) ?? 0) > 1, mentions(app, d.title, d.relPath, s)));
    read.push({
      relPath: d.relPath,
      absPath: join(root, d.relPath),
      title: d.title,
      type: d.docType ?? "note",
      flags: state.length ? [] : ["no-current-state"],
      entries,
    });
  }
  // Notes whose facts a project's session context carries come first: those are what sessions repeat.
  const loaded = notesInSessionContext(notes);
  const findings = read.map((f) => ({ ...f, inSessionIndex: loaded.has(f.relPath) }));
  const weight = (f: MemoryAuditReport["findings"][number]) => f.flags.length + f.entries.reduce((n, e) => n + e.flags.length + e.newerEvidence.length, 0);
  findings.sort((a, b) => Number(b.inSessionIndex) - Number(a.inSessionIndex) || weight(b) - weight(a) || a.relPath.localeCompare(b.relPath));
  const counts: Record<string, number> = {};
  for (const f of findings) for (const flag of [...f.flags, ...f.entries.flatMap((e) => e.flags)]) counts[flag] = (counts[flag] ?? 0) + 1;
  counts["newer-evidence"] = findings.reduce((n, f) => n + f.entries.filter((e) => e.newerEvidence.length).length, 0);
  return {
    generatedAt: nowIso(),
    dataFolder: root,
    notes: findings.length,
    entries: findings.reduce((n, f) => n + f.entries.length, 0),
    counts,
    findings,
    possibleDuplicates: duplicates(docs),
  };
}

function auditEntry(app: App, s: StateEntry, now: Date, duplicate: boolean, evidence: Mention[]): MemoryAuditEntry {
  const dated = Date.parse(`${s.date}T00:00:00Z`);
  const ageDays = Math.max(0, Math.floor((now.getTime() - dated) / DAY_MS));
  const flags: string[] = [];
  if (isPastReview(s.review, now)) flags.push("stale");
  if (!s.source) flags.push("unsourced");
  else if (sourceMissing(app, s.source)) flags.push("missing-source");
  if (duplicate) flags.push("duplicate-subject");
  // Evidence from the day the fact was dated is what it was written from; only later documents can overturn it.
  const newerEvidence = evidence
    .filter((m) => m.dated > s.date)
    .slice(0, EVIDENCE_PER_ENTRY)
    .map(({ dated, ...m }) => ({ ...m, modified: new Date(`${dated}T00:00:00Z`).toISOString() }));
  return { subject: s.subject, value: s.value, date: s.date, review: s.review ?? null, ageDays, source: s.source ?? null, line: s.line, flags, newerEvidence };
}

/** A source that names a file in the data folder which is no longer there. URLs, imports and sessions not yet archived are not checked. */
function sourceMissing(app: App, source: string): boolean {
  const m = SOURCE_RE.exec(source);
  const rel = m && LOCAL_KINDS.has(m[1]!) ? citedPath(source) : null;
  return rel !== null && !app.memory.exists(rel);
}

interface Mention {
  root: string;
  relPath: string;
  title: string;
  startLine: number;
  endLine: number;
  snippet: string;
  /** The day the passage speaks for (YYYY-MM-DD). */
  dated: string;
}

/** Copies of a retired notes system: their file time is when they were copied, not when they were true. */
const ARCHIVE_PREFIX = "evidence/archive/";
const EVIDENCE_AREAS = ["memory", "evidence", "import"];
const CONTENT_DATE_KEYS = ["observed_at", "captured_at", "date"];
/** A passage names a note when it holds at least this share of the words in the note's title. */
const NAME_COVERAGE = 0.5;

/**
 * Passages elsewhere that speak about one fact, most relevant first, one per document.
 * The search is for the note's name and the fact's subject, so each fact gets
 * its own leads. Left out, because they cannot overturn the fact: the document
 * the fact cites as its source, archives of a retired system, generated
 * deliverables, and superseded history or undated prose in other notes.
 */
function mentions(app: App, title: string, ownPath: string, fact: StateEntry): Mention[] {
  const cited = citedPath(fact.source);
  const hits = search(app.db, `${title} ${fact.subject}`, {
    limit: 30,
    areas: EVIDENCE_AREAS,
    excludePrefixes: [...RECALL_EXCLUDE, ARCHIVE_PREFIX, ownPath, ...(cited ? [cited] : [])],
    relativeCutoff: 0.5,
    maxPerDocument: 1,
  });
  const name = queryTerms(title);
  const out: Mention[] = [];
  for (const h of hits) {
    // Sharing the subject's words is not enough ("ownership", "platform"): the passage must name the note.
    if (termCoverage(`${h.title} ${h.text}`, name) < NAME_COVERAGE) continue;
    const dated = passageDate(app, h);
    if (dated) out.push({ root: h.root, relPath: h.relPath, title: h.title, startLine: h.startLine, endLine: h.endLine, snippet: h.snippet, dated });
  }
  return out;
}

/** The day a passage speaks for: a current fact's own date, a document's stated date, else the file's modification day. */
function passageDate(app: App, h: SearchHit): string | null {
  if (h.area === "memory") return h.section === "state" ? (parseStateLine(h.text.split("\n")[0]!)?.date ?? null) : null;
  for (const key of CONTENT_DATE_KEYS) {
    const v = h.meta[key];
    const day = typeof v === "string" ? v.slice(0, 10) : "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  }
  const row = app.db.prepare("select mtime_ms from documents where id = ?").get(h.docId) as { mtime_ms: number } | undefined;
  return row && row.mtime_ms > 0 ? new Date(row.mtime_ms).toISOString().slice(0, 10) : null;
}

/** The data-folder file a fact cites as its source, if it cites one. */
function citedPath(source: string | undefined): string | null {
  const m = source ? SOURCE_RE.exec(source) : null;
  if (!m) return null;
  const rel = m[2]!.replace(/#L\d+-L\d+$/, "");
  return /^(memory|evidence|deliverables)\/.+\.md$/.test(rel) ? rel : null;
}

function duplicates(docs: Array<{ relPath: string; title: string }>): MemoryAuditReport["possibleDuplicates"] {
  const byName = new Map<string, Array<{ relPath: string; title: string }>>();
  for (const d of docs) {
    const key = slugify(d.title);
    byName.set(key, [...(byName.get(key) ?? []), d]);
  }
  return [...byName.values()].filter((g) => g.length > 1).map((g) => ({ title: g[0]!.title, relPaths: g.map((d) => d.relPath).sort() }));
}
