import { formatStateEntry, parseStateLine, type Section } from "./markdown.ts";

/**
 * Cutting a Markdown section into the pieces recall retrieves and cites.
 *
 * A piece must be small enough to reach the model whole and narrow enough that
 * its line range points at the answer. So every current fact is its own piece,
 * and prose or lists are cut on paragraph and list-item boundaries.
 */
export interface Chunk {
  /** What the cited lines say, with HTML comments removed. */
  text: string;
  /** 1-based inclusive line range in the file. */
  startLine: number;
  endLine: number;
  /** What full-text search matches, when it differs from `text`. */
  searchText?: string;
  /** Extra words for the heading column: a fact's subject. */
  searchHeading?: string;
}

export type SectionKind = "state" | "history" | "body";

/** Aim for pieces of about this size, cutting where the text already pauses. */
const SOFT_CHARS = 1200;
/** Never let a piece grow past this, even when the text has no pause. */
const HARD_CHARS = 2400;

const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s/;
const FENCE = /^\s*(```|~~~)/;
const COMMENT = /<!--[\s\S]*?-->/g;

export function sectionKind(heading: string | null): SectionKind {
  const h = (heading ?? "").toLowerCase();
  return h === "current state" ? "state" : h === "history" ? "history" : "body";
}

export function chunkSection(section: Section): { kind: SectionKind; chunks: Chunk[] } {
  const kind = sectionKind(section.heading);
  const pieces = kind === "state" ? splitState(section.text, section.contentStartLine) : splitLong(section.text, section.contentStartLine);
  const chunks = pieces
    .map((p) => ({ ...p, text: p.text.replace(COMMENT, "").trim(), endLine: Math.max(p.startLine, Math.min(section.endLine, p.endLine)) }))
    .filter((p) => p.text);
  return { kind, chunks };
}

/**
 * One piece per current fact, cited at its own line. The fact's source and
 * Review date are provenance, not content: they stay in the cited text but are
 * not searchable, so a query never matches a fact because of the file it was
 * imported from or the day it is due for review.
 * Lines that are not facts (prose a person typed under the heading) are kept as ordinary pieces.
 */
function splitState(text: string, firstLine: number): Chunk[] {
  const out: Chunk[] = [];
  let fact: { lines: string[]; start: number; search: string; subject: string } | null = null;
  let loose: { lines: string[]; start: number } | null = null;
  const flushFact = () => {
    if (!fact) return;
    const rest = fact.lines.slice(1);
    out.push({ text: fact.lines.join("\n"), startLine: fact.start, endLine: fact.start + fact.lines.length - 1, searchText: [fact.search, ...rest].join("\n"), searchHeading: fact.subject });
    fact = null;
  };
  const flushLoose = () => {
    if (!loose) return;
    out.push(...splitLong(loose.lines.join("\n"), loose.start));
    loose = null;
  };
  text.split("\n").forEach((line, i) => {
    const lineNo = firstLine + i;
    const entry = parseStateLine(line);
    if (entry) {
      flushFact();
      flushLoose();
      fact = { lines: [line], start: lineNo, search: formatStateEntry({ ...entry, source: undefined, review: undefined }), subject: entry.subject };
    } else if (fact && /^\s+\S/.test(line)) {
      // Indented lines under a fact (sub-bullets added by hand) belong to it.
      fact.lines.push(line);
    } else {
      flushFact();
      loose = loose ? { ...loose, lines: [...loose.lines, line] } : { lines: [line], start: lineNo };
    }
  });
  flushFact();
  flushLoose();
  return out;
}

/**
 * Split text into pieces of about `SOFT_CHARS`, keeping exact line ranges.
 * A piece ends after a blank line or before a top-level list item once it is
 * long enough, and before any line that would take it past `HARD_CHARS`, so a
 * long list or a transcript without blank lines still yields narrow citations.
 * A single line longer than the hard limit stays whole: ranges are whole lines.
 */
export function splitLong(text: string, firstLine: number): Chunk[] {
  const lines = text.split("\n");
  const out: Chunk[] = [];
  let buf: string[] = [];
  let start = firstLine;
  let size = 0;
  let inFence = false;
  const cut = (nextStart: number) => {
    if (buf.length) out.push({ text: buf.join("\n"), startLine: start, endLine: nextStart - 1 });
    buf = [];
    size = 0;
    start = nextStart;
  };
  lines.forEach((line, i) => {
    const lineNo = firstLine + i;
    const pause = !inFence && size >= SOFT_CHARS && LIST_ITEM.test(line);
    if (buf.length && (pause || size + line.length + 1 > HARD_CHARS)) cut(lineNo);
    buf.push(line);
    size += line.length + 1;
    if (FENCE.test(line)) inFence = !inFence;
    if (!inFence && size >= SOFT_CHARS && line.trim() === "") cut(lineNo + 1);
  });
  cut(firstLine + lines.length);
  // Trim blank lines from both ends of a range so citations point at content.
  return out.flatMap((p) => {
    const ls = p.text.split("\n");
    let head = 0;
    while (head < ls.length && ls[head]!.trim() === "") head++;
    let tail = ls.length;
    while (tail > head && ls[tail - 1]!.trim() === "") tail--;
    return tail > head ? [{ text: ls.slice(head, tail).join("\n"), startLine: p.startLine + head, endLine: p.startLine + tail - 1 }] : [];
  });
}
