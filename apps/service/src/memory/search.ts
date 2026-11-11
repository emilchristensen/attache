import type { Db } from "../core/db.ts";

export interface SearchHit {
  chunkId: number;
  docId: string;
  root: string;
  relPath: string;
  area: string;
  docType: string | null;
  title: string;
  heading: string | null;
  section: "state" | "history" | "body";
  startLine: number;
  endLine: number;
  text: string;
  snippet: string;
  score: number;
  meta: Record<string, unknown>;
}

export interface SearchOptions {
  limit?: number;
  areas?: string[];
  docTypes?: string[];
  roots?: string[];
  excludePrefixes?: string[];
  /** Drop hits scoring below this fraction of the top hit. */
  relativeCutoff?: number;
  /** Most hits one document may take while other documents still have hits to show. Defaults to half of `limit`. */
  maxPerDocument?: number;
}

const STOPWORDS = new Set(
  (
    "a an and are as at be but by did do does for from had has have how i if in into is it its me my of on or our so than that the their them then there these they this to was we were what when where which who why will with you your about can could should would any some more most just also been being tell know please give show find"
  ).split(" "),
);

/** Tokenise a user query into safe FTS terms. Every term is quoted, so FTS operators in input are inert. */
export function queryTerms(query: string): string[] {
  const raw = query
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((t) => t.replace(/^[-_]+|[-_]+$/g, ""))
    .filter((t) => t.length >= 2);
  const terms = raw.filter((t) => !STOPWORDS.has(t));
  return [...new Set(terms.length ? terms : raw)].slice(0, 16);
}

const quote = (t: string) => `"${t.replace(/"/g, '""')}"`;

/** Raw archives that recall never quotes as evidence: chat archives from versions that had a chat, and coding-agent transcripts. Their summaries are searchable. */
export const RECALL_EXCLUDE = ["evidence/conversations/", "evidence/sessions/transcripts/"];

const AREA_WEIGHT: Record<string, number> = { memory: 1.0, import: 0.9, deliverables: 0.7, evidence: 0.75 };
const SECTION_WEIGHT: Record<string, number> = { state: 1.15, body: 1.0, history: 0.55 };
const RRF_K = 60;

export function search(db: Db, query: string, opts: SearchOptions = {}): SearchHit[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const limit = opts.limit ?? 8;
  const candidates = Math.max(limit * 6, 60);
  const lists: Array<Array<{ id: number; bm: number }>> = [];
  const run = (match: string) => {
    try {
      return db
        .prepare(`select rowid as id, bm25(chunks_fts, 6.0, 3.0, 1.0) as bm from chunks_fts where chunks_fts match ? order by bm limit ?`)
        .all(match, candidates) as Array<{ id: number; bm: number }>;
    } catch {
      return [];
    }
  };
  // All terms present (precise), any term as prefix (recall).
  if (terms.length > 1) lists.push(run(terms.map(quote).join(" AND ")));
  lists.push(run(terms.map((t) => `${quote(t)}*`).join(" OR ")));

  const fused = new Map<number, number>();
  for (const list of lists) {
    list.forEach((r, i) => fused.set(r.id, (fused.get(r.id) ?? 0) + 1 / (RRF_K + i + 1)));
  }
  if (!fused.size) return [];
  const ids = [...fused.keys()];
  const rows = db
    .prepare(
      `select c.id as chunkId, c.heading, c.section, c.start_line as startLine, c.end_line as endLine, c.text,
              d.id as docId, d.root, d.rel_path as relPath, d.area, d.doc_type as docType, d.title, d.meta
       from chunks c join documents d on d.id = c.doc_id where c.id in (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as Array<Omit<SearchHit, "score" | "snippet" | "meta"> & { meta: string }>;

  let hits: SearchHit[] = rows
    .filter((r) => (!opts.areas || opts.areas.includes(r.area)) && (!opts.docTypes || opts.docTypes.includes(r.docType ?? "")) && (!opts.roots || opts.roots.includes(r.root)) && !(opts.excludePrefixes ?? []).some((p) => r.root === "data" && r.relPath.startsWith(p)))
    .map((r) => {
      const meta = safeJson(r.meta);
      const coverage = termCoverage(`${r.title} ${r.heading ?? ""} ${r.text}`, terms);
      const status = typeof meta.status === "string" ? meta.status : "";
      const statusWeight = status === "superseded" || status === "archived" ? 0.6 : 1;
      const score = (fused.get(r.chunkId) ?? 0) * 1000 * (AREA_WEIGHT[r.area] ?? 0.8) * (SECTION_WEIGHT[r.section] ?? 1) * statusWeight * (0.5 + coverage);
      return { ...r, meta, score, snippet: makeSnippet(r.text, terms) };
    })
    .sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath) || a.startLine - b.startLine);

  const top = hits[0]?.score ?? 0;
  const cutoff = opts.relativeCutoff ?? 0.35;
  hits = hits.filter((h) => h.score >= top * cutoff);
  return diversify(hits, limit, opts.maxPerDocument ?? Math.max(2, Math.ceil(limit / 2)));
}

/**
 * The best `limit` hits, with no document taking more than `perDocument` of them
 * unless nothing else is left. A note is many small chunks (one per fact), so
 * without this a long note that matches by title would fill every slot.
 */
function diversify(sorted: SearchHit[], limit: number, perDocument: number): SearchHit[] {
  const taken = new Map<string, number>();
  const picked: SearchHit[] = [];
  const held: SearchHit[] = [];
  for (const h of sorted) {
    const n = taken.get(h.docId) ?? 0;
    if (n < perDocument) {
      picked.push(h);
      taken.set(h.docId, n + 1);
    } else held.push(h);
  }
  const chosen = new Set([...picked.slice(0, limit), ...held.slice(0, Math.max(0, limit - picked.length))]);
  return sorted.filter((h) => chosen.has(h));
}

/** The share of `terms` found in `text`, forgiving a different word ending. */
export function termCoverage(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  const found = terms.filter((t) => lower.includes(t.slice(0, Math.max(3, t.length - 2)))).length;
  return found / terms.length;
}

function safeJson(v: string): Record<string, unknown> {
  try {
    return JSON.parse(v) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function makeSnippet(text: string, terms: string[], width = 220): string {
  const lower = text.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    const p = lower.indexOf(t.slice(0, Math.max(3, t.length - 2)));
    if (p >= 0 && (pos < 0 || p < pos)) pos = p;
  }
  const start = Math.max(0, pos < 0 ? 0 : pos - 60);
  const s = text.slice(start, start + width).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + s + (start + width < text.length ? "…" : "");
}
