/**
 * Tolerant readers for Atlassian MCP tool results. The MCP server mirrors the
 * REST payloads but may flatten or rename fields between views, so adapters
 * read through these helpers and treat anything they cannot read as partial
 * coverage rather than as an empty result.
 */
import { RemoteError } from "./http.ts";

export function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null;
}

/** Read a nested property path, returning undefined when any step is missing. */
export function pick(v: unknown, ...path: string[]): unknown {
  let cur = v;
  for (const p of path) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/** Plain text of an Atlassian Document Format node (or a string, returned as is). */
export function adfText(node: unknown): string {
  if (typeof node === "string") return node;
  if (!node || typeof node !== "object") return "";
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (n.type === "text") return n.text ?? "";
  if (n.type === "hardBreak") return "\n";
  const inner = (n.content ?? []).map(adfText).join("");
  return n.type === "paragraph" ? `${inner}\n\n` : inner;
}

export function normalizeText(s: string): string {
  return s.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

export function authorId(c: Record<string, unknown>): string | null {
  return str(pick(c, "author", "accountId")) ?? str(pick(c, "author", "account_id")) ?? str(c.authorId) ?? str(pick(c, "version", "authorId"));
}

/** Comments from a Jira or Confluence list result, with the total when the result states it. */
export function commentsOf(res: unknown): { items: Array<Record<string, unknown>>; total: number | null } {
  const list = Array.isArray(res) ? res : ((pick(res, "comments") ?? pick(res, "results") ?? pick(res, "values")) as unknown);
  if (!Array.isArray(list)) throw new RemoteError("The comment list had an unexpected shape", "error");
  const total = pick(res, "total");
  return { items: list.filter((c): c is Record<string, unknown> => !!c && typeof c === "object"), total: typeof total === "number" ? total : null };
}
