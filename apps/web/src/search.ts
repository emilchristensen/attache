import type { MeaningStatus } from "@attache/contracts";
import type { EvidenceTarget } from "./components/Evidence.tsx";

/**
 * Search the Brain, the part every search surface shares (Home's field, the Brain screen, the palette of #34):
 * what to ask the service, what a result says about itself, where it opens and how the ranking is explained.
 * Pure, so `apps/web/test/search.test.ts` can hold the rules.
 */

/** One passage `GET /memory/search` returns. */
export interface SearchHit {
  chunkId: number;
  root: string;
  relPath: string;
  area: string;
  docType: string | null;
  title: string;
  heading: string | null;
  section: "state" | "history" | "body";
  startLine: number;
  endLine: number;
  snippet: string;
  review: string | null;
  unverified: boolean;
}

export interface SearchAnswer {
  hits: SearchHit[];
  meaning: MeaningStatus;
}

/** How many results show under a search field before "All results in Brain". */
export const INLINE_RESULTS = 6;
/** How long typing must pause before the field asks the service. */
export const SEARCH_DEBOUNCE_MS = 150;

/**
 * What a search field asks for: passages the way recall finds them (`recall=1`), so session summaries come back
 * but raw session transcripts and old chat archives stay out. The Brain screen's own search still covers everything.
 */
export function searchPath(query: string, limit: number): string {
  return `/memory/search?q=${encodeURIComponent(query.trim())}&limit=${limit}&recall=1`;
}

/** The Brain screen with the query in its address ("All results in Brain"). */
export function brainResultsHref(query: string): string {
  const q = query.trim();
  return q ? `/brain?q=${encodeURIComponent(q)}` : "/brain";
}

export type HitDestination = { kind: "brain"; href: string } | { kind: "evidence"; target: EvidenceTarget };

/** A memory note opens in the Brain (with the query kept), anything else in the evidence view at the cited lines. */
export function hitDestination(hit: SearchHit, query: string): HitDestination {
  if (hit.root === "data" && hit.relPath.startsWith("memory/")) {
    const params = new URLSearchParams({ root: hit.root, path: hit.relPath });
    if (query.trim()) params.set("q", query.trim());
    return { kind: "brain", href: `/brain?${params.toString()}` };
  }
  return { kind: "evidence", target: { root: hit.root, relPath: hit.relPath, lines: [hit.startLine, hit.endLine], title: hit.title } };
}

const DOC_TYPE_WORD: Record<string, string> = { person: "Person", project: "Project", decision: "Decision", note: "Note" };
const AREA_WORD: Record<string, string> = { memory: "Note", import: "Imported", evidence: "Evidence", deliverables: "Deliverable" };
const SECTION_WORD: Record<SearchHit["section"], string | null> = { state: "Current state", history: "History", body: null };

/** What kind of thing a passage is in, and which part of a note it comes from (none for the body). */
export function hitKind(hit: SearchHit): { kind: string; section: string | null } {
  const kind = (hit.docType && DOC_TYPE_WORD[hit.docType]) ?? AREA_WORD[hit.area] ?? "Note";
  return { kind, section: SECTION_WORD[hit.section] };
}

/** Where a passage comes from: its file and cited lines, after the folder's name when it is not the data folder. */
export function hitPlace(hit: SearchHit): string {
  const lines = hit.startLine === hit.endLine ? `${hit.startLine}` : `${hit.startLine}-${hit.endLine}`;
  return `${hit.root !== "data" ? `${hit.root} › ` : ""}${hit.relPath}:${lines}`;
}

export type RankingLine = { ranking: "meaning"; text: string } | { ranking: "keywords"; text: string; reason: string };

/** How the results were ranked, and why only by keywords while meaning-based search is not ready. */
export function rankingLine(meaning: MeaningStatus): RankingLine {
  if (meaning.ranking === "meaning" || meaning.state === "ready") return { ranking: "meaning", text: "Ranked by meaning and keywords." };
  const why: Record<Exclude<MeaningStatus["state"], "ready">, string> = {
    missing: "the meaning model is not downloaded",
    downloading: "the meaning model is downloading",
    failed: "meaning-based search stopped with an error",
    building: `search vectors are being built (${meaning.vectors.embedded} of ${meaning.vectors.chunks})`,
  };
  return { ranking: "keywords", text: "Ranked by keywords only", reason: why[meaning.state] };
}

/** The fewest px of results the list keeps when the window is short; the page scrolls for the rest. */
export const MIN_RESULTS_PX = 160;
/** Space kept between the results and the bottom of the visible page. */
export const RESULTS_MARGIN_PX = 12;

/** Where the open results sit, in window px: the list's top, the popup's height under it, and the page's visible part. */
export interface ResultsGeometry {
  listTop: number;
  below: number;
  visibleTop: number;
  visibleBottom: number;
}

/**
 * The most px the results list may take: what is left of the visible page under it, so the list scrolls on its own
 * and never pushes the page. A list that starts above the visible page (the page is scrolled) counts from the
 * page's top, so its height never grows with the scroll; a short window keeps `MIN_RESULTS_PX`.
 */
export function resultsRoom({ listTop, below, visibleTop, visibleBottom }: ResultsGeometry): number {
  return Math.max(MIN_RESULTS_PX, visibleBottom - Math.max(listTop, visibleTop) - below - RESULTS_MARGIN_PX);
}

/**
 * The chosen result after an arrow key, in a list of `count`, wrapping round; -1 is none chosen.
 * Home and End stay with the text, as they do in any editable field (`caretAfter`).
 */
export function moveActive(active: number, count: number, key: "ArrowDown" | "ArrowUp"): number {
  if (count === 0) return -1;
  if (key === "ArrowDown") return active < 0 ? 0 : (active + 1) % count;
  return active <= 0 ? count - 1 : active - 1;
}
