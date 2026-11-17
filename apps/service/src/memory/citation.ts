import type { Citation } from "@attache/contracts";
import type { SearchHit } from "./search.ts";

/** The citation `[S<n>]` for the n-th search hit (from 0) that research findings or a draft were written from. */
export function toCitation(h: SearchHit, i: number): Citation {
  const m = h.meta;
  const observed = (typeof m.updated === "string" && m.updated) || (typeof m.captured_at === "string" && m.captured_at) || (typeof m.created === "string" && m.created) || null;
  return { marker: `S${i + 1}`, docId: h.docId, root: h.root, relPath: h.relPath, title: h.title, heading: h.heading, section: h.section, startLine: h.startLine, endLine: h.endLine, snippet: h.snippet, area: h.area, observedAt: observed ? String(observed) : null };
}
