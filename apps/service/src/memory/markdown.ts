import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * Jarvis memory notes are plain Markdown with YAML frontmatter.
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
  value: string;
  source?: string;
  line: number;
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function splitFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string; bodyStartLine: number; error?: string } {
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
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
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

const STATE_RE = /^- \*\*(.+?)\*\* \((\d{4}-\d{2}-\d{2})\): (.*?)(?: — source: (.+))?$/;

/** One `- **Subject** (date): value — source: …` line, or null when the line is not a state entry. */
export function parseStateLine(line: string): Omit<StateEntry, "line"> | null {
  const m = STATE_RE.exec(line);
  return m ? { subject: m[1]!, date: m[2]!, value: m[3]!, ...(m[4] ? { source: m[4] } : {}) } : null;
}

export function parseStateEntries(raw: string): StateEntry[] {
  const lines = raw.split("\n");
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

export function formatStateEntry(e: { subject: string; date: string; value: string; source?: string | undefined }): string {
  const value = e.value.replace(/\s*\n\s*/g, " ").trim();
  return `- **${e.subject.replace(/\*\*/g, "")}** (${e.date}): ${value}${e.source ? ` — source: ${e.source}` : ""}`;
}

export interface MemoryDocInput {
  frontmatter: Record<string, unknown>;
  title: string;
  state: Array<{ subject: string; date: string; value: string; source?: string | undefined }>;
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
 * History. Returns the new file text and the prior entry, if any.
 */
export function applyStateCorrection(
  raw: string,
  entry: { subject: string; date: string; value: string; source?: string | undefined },
  reason: string,
): { text: string; previous: StateEntry | null } {
  const lines = raw.split("\n");
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
  let text = lines.join("\n");
  if (previous) {
    const hist = `- ${entry.date} — **${previous.subject}** was "${previous.value}" (dated ${previous.date}${previous.source ? `, source: ${previous.source}` : ""}); superseded: ${reason.replace(/\s*\n\s*/g, " ")}`;
    text = appendHistory(text, hist);
  }
  return { text, previous };
}

export function appendHistory(raw: string, line: string): string {
  const trimmed = raw.replace(/\s+$/, "");
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
