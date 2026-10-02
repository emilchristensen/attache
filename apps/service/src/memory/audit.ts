import { join } from "node:path";
import type { MemoryAuditEntry, MemoryAuditReport } from "@jarvis/contracts";
import type { App } from "../app.ts";
import { nowIso } from "../core/db.ts";
import { MAX_DETAILED_PER_TYPE } from "../agents/context.ts";
import { parseStateEntries, slugify, type StateEntry } from "./markdown.ts";
import { RECALL_EXCLUDE, search } from "./search.ts";

export const DEFAULT_STALE_DAYS = 60;
const EVIDENCE_PER_ENTRY = 3;
const DAY_MS = 86_400_000;

/** `label (kind: where, observed date)`, the shape `formatSource` writes. */
const SOURCE_RE = /\((capture|note|import|connector|conversation|user|agent-session): (.+?), observed \d{4}-\d{2}-\d{2}\)$/;
const LOCAL_KINDS = new Set(["capture", "note", "conversation", "agent-session"]);

/**
 * The deterministic half of a memory audit: every current fact in curated
 * memory with its age, source and the newer documents that mention its note.
 * It counts and flags; judging whether newer evidence contradicts a fact is
 * left to whoever reads the report. Read-only.
 */
export function auditMemory(app: App, opts: { staleDays?: number; now?: Date } = {}): MemoryAuditReport {
  const root = app.memory.dataRoot;
  if (!root) throw new Error("Choose a data folder first");
  const now = opts.now ?? new Date();
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const docs = app.memory.listDocuments({ area: "memory", root: "data", limit: 2000 }).filter((d) => d.relPath !== "memory/self.md");
  const loaded = sessionIndexed(docs);
  const findings: MemoryAuditReport["findings"] = [];
  for (const d of docs) {
    let raw: string;
    try {
      raw = app.memory.read(d.relPath);
    } catch {
      continue;
    }
    const state = parseStateEntries(raw);
    const evidence = newerMentions(app, d.title, d.relPath);
    const subjects = new Map<string, number>();
    for (const s of state) subjects.set(s.subject.toLowerCase(), (subjects.get(s.subject.toLowerCase()) ?? 0) + 1);
    const entries = state.map((s) => auditEntry(app, s, now, staleDays, (subjects.get(s.subject.toLowerCase()) ?? 0) > 1, evidence));
    findings.push({
      relPath: d.relPath,
      absPath: join(root, d.relPath),
      title: d.title,
      type: d.docType ?? "note",
      inSessionIndex: loaded.has(d.relPath),
      flags: state.length ? [] : ["no-current-state"],
      entries,
    });
  }
  const weight = (f: MemoryAuditReport["findings"][number]) => f.flags.length + f.entries.reduce((n, e) => n + e.flags.length + e.newerEvidence.length, 0);
  findings.sort((a, b) => Number(b.inSessionIndex) - Number(a.inSessionIndex) || weight(b) - weight(a) || a.relPath.localeCompare(b.relPath));
  const counts: Record<string, number> = {};
  for (const f of findings) for (const flag of [...f.flags, ...f.entries.flatMap((e) => e.flags)]) counts[flag] = (counts[flag] ?? 0) + 1;
  counts["newer-evidence"] = findings.reduce((n, f) => n + f.entries.filter((e) => e.newerEvidence.length).length, 0);
  return {
    generatedAt: nowIso(),
    dataFolder: root,
    staleDays,
    notes: findings.length,
    entries: findings.reduce((n, f) => n + f.entries.length, 0),
    counts,
    findings,
    possibleDuplicates: duplicates(docs),
  };
}

function auditEntry(app: App, s: StateEntry, now: Date, staleDays: number, duplicate: boolean, evidence: Mention[]): MemoryAuditEntry {
  const dated = Date.parse(`${s.date}T00:00:00Z`);
  const ageDays = Math.max(0, Math.floor((now.getTime() - dated) / DAY_MS));
  const flags: string[] = [];
  if (ageDays > staleDays) flags.push("stale");
  if (!s.source) flags.push("unsourced");
  else if (sourceMissing(app, s.source)) flags.push("missing-source");
  if (duplicate) flags.push("duplicate-subject");
  // Evidence from the day the fact was dated is what it was written from; only later documents can overturn it.
  const after = dated + DAY_MS;
  const newerEvidence = evidence
    .filter((m) => m.mtimeMs >= after)
    .slice(0, EVIDENCE_PER_ENTRY)
    .map(({ mtimeMs, ...m }) => ({ ...m, modified: new Date(mtimeMs).toISOString() }));
  return { subject: s.subject, value: s.value, date: s.date, ageDays, source: s.source ?? null, line: s.line, flags, newerEvidence };
}

/** A source that names a file in the data folder which is no longer there. URLs, imports and sessions not yet archived are not checked. */
function sourceMissing(app: App, source: string): boolean {
  const m = SOURCE_RE.exec(source);
  if (!m || !LOCAL_KINDS.has(m[1]!)) return false;
  const rel = m[2]!.replace(/#L\d+-L\d+$/, "");
  if (!/^(memory|evidence|deliverables)\/.+\.md$/.test(rel)) return false;
  return !app.memory.exists(rel);
}

interface Mention {
  root: string;
  relPath: string;
  title: string;
  startLine: number;
  endLine: number;
  snippet: string;
  mtimeMs: number;
}

/** Other documents that mention a note's title, newest first, one hit per document. */
function newerMentions(app: App, title: string, ownPath: string): Mention[] {
  const hits = search(app.db, title, { limit: 30, excludePrefixes: RECALL_EXCLUDE, relativeCutoff: 0.5 });
  const seen = new Set<string>();
  const out: Mention[] = [];
  for (const h of hits) {
    const key = `${h.root}:${h.relPath}`;
    if ((h.root === "data" && h.relPath === ownPath) || seen.has(key)) continue;
    seen.add(key);
    const mtime = app.db.prepare("select mtime_ms from documents where id = ?").get(h.docId) as { mtime_ms: number } | undefined;
    out.push({ root: h.root, relPath: h.relPath, title: h.title, startLine: h.startLine, endLine: h.endLine, snippet: h.snippet, mtimeMs: mtime?.mtime_ms ?? 0 });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** The notes whose first fact every new agent session reads (see `buildSessionContext`). */
function sessionIndexed(docs: Array<{ relPath: string; docType: string | null; title: string }>): Set<string> {
  const perType = new Map<string, number>();
  const out = new Set<string>();
  for (const d of docs.filter((x) => x.title)) {
    const t = d.docType ?? "note";
    const n = perType.get(t) ?? 0;
    if (n < MAX_DETAILED_PER_TYPE) out.add(d.relPath);
    perType.set(t, n + 1);
  }
  return out;
}

function duplicates(docs: Array<{ relPath: string; title: string }>): MemoryAuditReport["possibleDuplicates"] {
  const byName = new Map<string, Array<{ relPath: string; title: string }>>();
  for (const d of docs) {
    const key = slugify(d.title);
    byName.set(key, [...(byName.get(key) ?? []), d]);
  }
  return [...byName.values()].filter((g) => g.length > 1).map((g) => ({ title: g[0]!.title, relPaths: g.map((d) => d.relPath).sort() }));
}
