import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Attache memory notes are plain Markdown with YAML frontmatter.
 *
 * State versus event: `## Current State` holds one dated entry per subject and
 * is REPLACED on correction; `## History` is append-only and keeps every
 * superseded value with its date and reason. The structure carries the rule,
 * so a correction cannot silently leave a stale value looking current.
 */

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  /** Body without frontmatter. */
  body: string;
  /** 1-based line number in the full file where the body starts. */
  bodyStartLine: number;
  title: string;
  sections: Section[];
}

export interface Section {
  heading: string | null;
  level: number;
  /** 1-based inclusive line range in the full file. */
  startLine: number;
  endLine: number;
  /** 1-based line of the first non-blank content line after the heading. */
  contentStartLine: number;
  text: string;
}

export interface StateEntry {
  subject: string;
  date: string;
  /** The day after which the fact should be checked again, when one is set. */
  review?: string;
  value: string;
  source?: string;
  line: number;
}

const FM_RE = /^---\n([\s\S]*?)\n---\n?/;

/**
 * A note's text with LF line endings. An editor on Windows may save a note
 * with CRLF; Attache reads it the same, and everything it writes is LF, as
 * the Brain repository stores it on every Machine.
 */
export function toLf(text: string): string {
  return text.includes("\r\n") ? text.replace(/\r\n/g, "\n") : text;
}

export function splitFrontmatter(text: string): { frontmatter: Record<string, unknown>; body: string; bodyStartLine: number; error?: string } {
  const raw = toLf(text);
  const m = FM_RE.exec(raw);
  if (!m) return { frontmatter: {}, body: raw, bodyStartLine: 1 };
  let frontmatter: Record<string, unknown> = {};
  let error: string | undefined;
  try {
    const parsed = parseYaml(m[1]!);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) frontmatter = parsed as Record<string, unknown>;
  } catch (e) {
    error = `Invalid frontmatter: ${(e as Error).message}`;
  }
  const consumed = m[0];
  const bodyStartLine = consumed.split("\n").length - (consumed.endsWith("\n") ? 1 : 0) + 1;
  return { frontmatter, body: raw.slice(consumed.length), bodyStartLine, ...(error ? { error } : {}) };
}

/** The title of a file with none of its own: its file name without `.md`. */
export function fileTitle(relPath: string): string {
  return relPath.split("/").at(-1)!.replace(/\.md$/, "");
}

/** A line that opens or closes a fenced code block. */
export const CODE_FENCE = /^\s*(```|~~~)/;

export function parseMarkdown(raw: string, fallbackTitle: string): ParsedMarkdown {
  const { frontmatter, body, bodyStartLine } = splitFrontmatter(raw);
  const lines = body.split("\n");
  const sections: Section[] = [];
  let current: Section = { heading: null, level: 0, startLine: bodyStartLine, endLine: bodyStartLine, contentStartLine: bodyStartLine, text: "" };
  let buf: string[] = [];
  let inFence = false;
  let h1: string | null = null;
  const flush = (endLine: number) => {
    current.endLine = Math.max(current.startLine, endLine);
    const contentOffset = current.heading ? 1 : 0;
    let lead = 0;
    while (lead < buf.length && buf[lead]!.trim() === "") lead++;
    current.contentStartLine = current.startLine + contentOffset + lead;
    current.text = buf.slice(lead).join("\n").trimEnd();
    if (current.text || current.heading) sections.push(current);
  };
  lines.forEach((line, i) => {
    const lineNo = bodyStartLine + i;
    if (CODE_FENCE.test(line)) inFence = !inFence;
    const hm = !inFence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (hm) {
      flush(lineNo - 1);
      const level = hm[1]!.length;
      const heading = hm[2]!.trim();
      if (level === 1 && h1 === null) h1 = heading;
      current = { heading, level, startLine: lineNo, endLine: lineNo, contentStartLine: lineNo + 1, text: "" };
      buf = [];
    } else {
      buf.push(line);
    }
  });
  flush(bodyStartLine + lines.length - 1);
  const fmTitle = typeof frontmatter.title === "string" ? frontmatter.title : null;
  return { frontmatter, body, bodyStartLine, title: fmTitle || h1 || fallbackTitle, sections };
}

/**
 * `- **Subject** (date[, review date]): value[ — source: …]`. Attache writes
 * `(2026-11-10, review 2026-11-13)`; a hand edit may vary the spacing, the
 * case of "review" or add a colon after it, and still reads the same.
 */
const STATE_RE = /^- \*\*(.+?)\*\* \((\d{4}-\d{2}-\d{2})(?:\s*,\s*[Rr]eview:?\s*(\d{4}-\d{2}-\d{2}))?\s*\): (.*?)(?: — source: (.+))?$/;

/** One `- **Subject** (date[, review date]): value — source: …` line, or null when the line is not a state entry. */
export function parseStateLine(line: string): Omit<StateEntry, "line"> | null {
  const m = STATE_RE.exec(line.endsWith("\r") ? line.slice(0, -1) : line);
  return m ? { subject: m[1]!, date: m[2]!, ...(m[3] ? { review: m[3] } : {}), value: m[4]!, ...(m[5] ? { source: m[5] } : {}) } : null;
}

export function parseStateEntries(raw: string): StateEntry[] {
  const lines = toLf(raw).split("\n");
  const out: StateEntry[] = [];
  let inState = false;
  lines.forEach((line, i) => {
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (h) inState = h[2]!.trim().toLowerCase() === "current state";
    else if (inState) {
      const entry = parseStateLine(line);
      if (entry) out.push({ ...entry, line: i + 1 });
    }
  });
  return out;
}

/** What a current-state entry holds, as the writer takes it. */
export interface StateEntryInput {
  subject: string;
  date: string;
  review?: string | undefined;
  value: string;
  source?: string | undefined;
}

export function formatStateEntry(e: StateEntryInput): string {
  const value = e.value.replace(/\s*\n\s*/g, " ").trim();
  return `- **${e.subject.replace(/\*\*/g, "")}** (${e.date}${e.review ? `, review ${e.review}` : ""}): ${value}${e.source ? ` — source: ${e.source}` : ""}`;
}

export interface MemoryDocInput {
  frontmatter: Record<string, unknown>;
  title: string;
  state: StateEntryInput[];
  notes?: string;
  history?: string[];
}

export function renderMemoryDoc(doc: MemoryDocInput): string {
  const fm = stringifyYaml(doc.frontmatter, { lineWidth: 0 }).trimEnd();
  const parts = [
    `---\n${fm}\n---`,
    `# ${doc.title}`,
    `## Current State\n<!-- One entry per subject, dated. Corrections replace the entry; the old value moves to History. -->\n${doc.state.map(formatStateEntry).join("\n")}`,
  ];
  if (doc.notes && doc.notes.trim()) parts.push(`## Notes\n${doc.notes.trim()}`);
  parts.push(`## History\n<!-- Append-only. Never edited. -->\n${(doc.history ?? []).join("\n")}`);
  return parts.join("\n\n").trimEnd() + "\n";
}

/**
 * Replace (or add) one subject's state entry and append the superseded value to
 * History. The new entry carries only the Review date it is given, so a date
 * set for the old value never follows the new one. Returns the new file text
 * and the prior entry, if any.
 */
export function applyStateCorrection(
  raw: string,
  entry: StateEntryInput,
  reason: string,
): { text: string; previous: StateEntry | null } {
  const lines = toLf(raw).split("\n");
  const entries = parseStateEntries(raw);
  const previous = entries.find((e) => e.subject.toLowerCase() === entry.subject.toLowerCase()) ?? null;
  const newLine = formatStateEntry(entry);
  if (previous) {
    lines[previous.line - 1] = newLine;
  } else {
    let stateIdx = lines.findIndex((l) => /^#{1,6}\s+current state\s*$/i.test(l));
    if (stateIdx < 0) {
      const h1 = lines.findIndex((l) => /^#\s+/.test(l));
      const at = h1 >= 0 ? h1 + 1 : 0;
      lines.splice(at, 0, "", "## Current State");
      stateIdx = at + 1;
    }
    let insertAt = stateIdx + 1;
    while (insertAt < lines.length && !/^#{1,6}\s/.test(lines[insertAt]!)) {
      if (lines[insertAt]!.trim() !== "") insertAt++;
      else if (insertAt + 1 < lines.length && /^- \*\*/.test(lines[insertAt + 1]!)) insertAt++;
      else break;
    }
    lines.splice(insertAt, 0, newLine);
  }
  const text = lines.join("\n");
  return { text: previous ? appendHistory(text, formerValueLine(entry.date, previous, "superseded", reason)) : text, previous };
}

/**
 * Take one subject's entry (and any indented lines under it) out of Current
 * State and keep the removed value in History. Returns the text unchanged and
 * `removed: null` when the subject has no entry.
 */
export function removeStateEntry(raw: string, entry: { subject: string; date: string }, reason: string): { text: string; removed: StateEntry | null } {
  const removed = parseStateEntries(raw).find((e) => e.subject.toLowerCase() === entry.subject.toLowerCase()) ?? null;
  if (!removed) return { text: raw, removed: null };
  const lines = toLf(raw).split("\n");
  let end = removed.line;
  while (end < lines.length && /^\s+\S/.test(lines[end]!)) end++;
  const text = [...lines.slice(0, removed.line - 1), ...lines.slice(end)].join("\n");
  return { text: appendHistory(text, formerValueLine(entry.date, removed, "removed", reason)), removed };
}

/**
 * The History line that keeps a value no longer current:
 * `- <date> — **Subject** was "<value>" (dated <d>[, review <r>][, source: …]); <outcome>: <reason>`.
 */
export function formerValueLine(date: string, former: Omit<StateEntry, "line">, outcome: "superseded" | "removed", reason: string): string {
  return `- ${date} — **${former.subject}** was "${former.value}" (dated ${former.date}${former.review ? `, review ${former.review}` : ""}${former.source ? `, source: ${former.source}` : ""}); ${outcome}: ${reason.replace(/\s*\n\s*/g, " ")}`;
}

export function appendHistory(raw: string, line: string): string {
  const trimmed = toLf(raw).replace(/\s+$/, "");
  if (/^#{1,6}\s+history\s*$/im.test(trimmed)) {
    // History is the last section by construction; if not, append at file end regardless.
    return `${trimmed}\n${line}\n`;
  }
  return `${trimmed}\n\n## History\n<!-- Append-only. Never edited. -->\n${line}\n`;
}

export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}
