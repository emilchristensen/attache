import { placeholders, type Db } from "../core/db.ts";
import { parseStateLine } from "./markdown.ts";
import { markdownToPlainText } from "./plain-text.ts";
import { collapseSpaces } from "./same-text.ts";
import { isPastReview } from "./review-date.ts";

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
  /** A current fact's Review date, when the hit is a fact that has one. */
  review: string | null;
  /** The hit is a current fact past its Review date: still in the Brain, but to be checked before relying on it. */
  unverified: boolean;
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
  /** Chunk ids nearest the question by meaning, best first: fused with the two keyword lists as a third. */
  meaning?: readonly number[];
}

/**
 * Finds the chunks nearest a question by meaning, best first; empty while
 * search ranks by keywords alone. Like the keyword lists, it ranks every
 * chunk in the index, and search drops what it leaves out after fusion.
 */
export type NearestChunks = (query: string, limit: number) => Promise<number[]>;

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

/** Raw archives that recall never quotes as evidence: chat archives from versions that had a chat, and Harness session transcripts. Their summaries are searchable. */
export const RECALL_EXCLUDE = ["evidence/conversations/", "evidence/sessions/transcripts/"];

const AREA_WEIGHT: Record<string, number> = { memory: 1.0, import: 0.9, deliverables: 0.7, evidence: 0.75 };
const SECTION_WEIGHT: Record<string, number> = { state: 1.15, body: 1.0, history: 0.55 };
const RRF_K = 60;

/** How deep each ranked list goes before fusion. */
const candidatesFor = (limit: number) => Math.max(limit * 6, 60);

/** Search, with the chunks nearest the question by meaning as a third list. */
export async function searchByMeaning(db: Db, query: string, nearest: NearestChunks, opts: Omit<SearchOptions, "meaning"> = {}): Promise<SearchHit[]> {
  if (!queryTerms(query).length) return [];
  return search(db, query, { ...opts, meaning: await nearest(query, candidatesFor(opts.limit ?? 8)) });
}

export function search(db: Db, query: string, opts: SearchOptions = {}): SearchHit[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const limit = opts.limit ?? 8;
  const candidates = candidatesFor(limit);
  const lists: Array<ReadonlyArray<{ id: number }>> = [];
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
  if (opts.meaning?.length) lists.push(opts.meaning.slice(0, candidates).map((id) => ({ id })));

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
       from chunks c join documents d on d.id = c.doc_id where c.id in (${placeholders(ids)})`,
    )
    .all(...ids) as Array<Omit<SearchHit, "score" | "snippet" | "meta" | "review" | "unverified"> & { meta: string }>;

  let hits: Array<Omit<SearchHit, "snippet" | "review" | "unverified">> = rows
    .filter((r) => (!opts.areas || opts.areas.includes(r.area)) && (!opts.docTypes || opts.docTypes.includes(r.docType ?? "")) && (!opts.roots || opts.roots.includes(r.root)) && !(opts.excludePrefixes ?? []).some((p) => r.root === "data" && r.relPath.startsWith(p)))
    .map((r) => {
      const meta = safeJson(r.meta);
      const coverage = termCoverage(`${r.title} ${r.heading ?? ""} ${r.text}`, terms);
      const status = typeof meta.status === "string" ? meta.status : "";
      const statusWeight = status === "superseded" || status === "archived" ? 0.6 : 1;
      const score = (fused.get(r.chunkId) ?? 0) * 1000 * (AREA_WEIGHT[r.area] ?? 0.8) * (SECTION_WEIGHT[r.section] ?? 1) * statusWeight * (0.5 + coverage);
      return { ...r, meta, score };
    })
    .sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath) || a.startLine - b.startLine);

  const top = hits[0]?.score ?? 0;
  const cutoff = opts.relativeCutoff ?? 0.35;
  hits = hits.filter((h) => h.score >= top * cutoff);
  const now = new Date();
  // Snippets are made only for the hits returned: each one parses its chunk's Markdown.
  return diversify(hits, limit, opts.maxPerDocument ?? Math.max(2, Math.ceil(limit / 2))).map((h) => withReview({ ...h, snippet: makeSnippet(h.text, terms) }, now));
}

/** Mark a current fact with its Review date, and as unverified once that day has passed. */
function withReview<T extends Omit<SearchHit, "review" | "unverified">>(hit: T, now: Date): T & Pick<SearchHit, "review" | "unverified"> {
  const review = (hit.section === "state" && parseStateLine(hit.text.split("\n")[0] ?? "")?.review) || null;
  return { ...hit, review, unverified: isPastReview(review, now) };
}

/**
 * The best `limit` hits, with no document taking more than `perDocument` of them
 * unless nothing else is left. A note is many small chunks (one per fact), so
 * without this a long note that matches by title would fill every slot.
 */
function diversify<T extends { docId: string }>(sorted: T[], limit: number, perDocument: number): T[] {
  const taken = new Map<string, number>();
  const picked: T[] = [];
  const held: T[] = [];
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

/** A term without its last letters, so a different word ending still matches. */
const termStem = (term: string) => term.slice(0, Math.max(3, term.length - 2));

/** The share of `terms` found in `text`, forgiving a different word ending. */
export function termCoverage(text: string, terms: string[]): number {
  const lower = text.toLowerCase();
  const found = terms.filter((t) => lower.includes(termStem(t))).length;
  return found / terms.length;
}

function safeJson(v: string): Record<string, unknown> {
  try {
    return JSON.parse(v) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** About how many characters a snippet shows. */
const SNIPPET_WIDTH = 220;
/** How far before the first match a snippet starts. */
const SNIPPET_LEAD = 60;
/** How far a cut may move to fall between words; past that it splits the word. */
const WORD_SNAP = 20;

/**
 * About `SNIPPET_WIDTH` characters of the plain words of `text` (no Markdown syntax),
 * starting a little before the first matched term and cut between words, with
 * `…` where it was cut.
 */
export function makeSnippet(text: string, terms: string[]): string {
  const plain = collapseSpaces(markdownToPlainText(text));
  const match = firstMatch(plain.toLowerCase(), terms) ?? { start: 0, end: 0 };
  const start = cutBefore(plain, Math.max(0, match.start - SNIPPET_LEAD), match.start);
  const end = cutAfter(plain, Math.min(plain.length, start + SNIPPET_WIDTH), Math.max(match.end, start));
  return (start > 0 ? "…" : "") + plain.slice(start, end).trim() + (end < plain.length ? "…" : "");
}

/** Where the earliest term (by its stem) sits in `lower`, or null when none does. */
function firstMatch(lower: string, terms: string[]): { start: number; end: number } | null {
  return terms
    .map(termStem)
    .map((stem) => ({ start: lower.indexOf(stem), end: lower.indexOf(stem) + stem.length }))
    .filter((m) => m.start >= 0)
    .reduce<{ start: number; end: number } | null>((best, m) => (!best || m.start < best.start ? m : best), null);
}

/** A cut at `at` moved forward to the start of the next word, unless that passes `limit` or is too far. */
function cutBefore(plain: string, at: number, limit: number): number {
  if (at === 0) return 0;
  const space = plain.indexOf(" ", at - 1);
  return space >= 0 && space < limit && space - at < WORD_SNAP ? space + 1 : at;
}

/** A cut at `at` moved back to the end of the previous word, unless that reaches `floor` or is too far. */
function cutAfter(plain: string, at: number, floor: number): number {
  if (at >= plain.length) return plain.length;
  const space = plain.lastIndexOf(" ", at);
  return space > floor && at - space < WORD_SNAP ? space : at;
}
