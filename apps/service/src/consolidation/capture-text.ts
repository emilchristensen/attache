import { redact } from "../core/log.ts";
import { splitFrontmatter } from "../memory/markdown.ts";
import { normalizeRel } from "../memory/policy.ts";

/** Where meeting captures live in the Brain. Connector snapshots live elsewhere, so they are never one. */
export const CAPTURES_DIR = "evidence/captures";
/** A capture is a meeting capture when its frontmatter `tags` hold one of these. */
export const MEETING_TAGS: readonly string[] = ["meeting", "meeting-transcript"];

const MAX_QUERIES = 20;
const MAX_QUERY_CHARS = 200;

/** One line of a capture as Consolidation reads it, with the line of the file it came from. */
export interface CaptureLine {
  text: string;
  line: number;
}

/** A meeting capture ready to be read: its title, its lines and what to search the Brain for. */
export interface MeetingCapture {
  title: string;
  lines: readonly CaptureLine[];
  /** The title, the headings and the first points, as searches for related notes. */
  queries: readonly string[];
}

/** Whether a path in the data folder is in the captures area, where meeting captures arrive. */
export function inCapturesArea(relPath: string): boolean {
  const rel = normalizeRel(relPath.replace(/^\.\//, ""));
  return rel.startsWith(`${CAPTURES_DIR}/`) && rel.endsWith(".md");
}

/** Whether a capture's frontmatter marks it as a meeting. */
export function isMeeting(raw: string): boolean {
  const tags = splitFrontmatter(raw).frontmatter.tags;
  const list = Array.isArray(tags) ? tags : typeof tags === "string" ? tags.split(/[,\s]+/) : [];
  return list.some((t) => typeof t === "string" && MEETING_TAGS.includes(t.trim().toLowerCase()));
}

/**
 * A meeting capture's body as the model reads it: redacted, one entry per
 * line of the file, without the quote markers the capture is stored in, so a
 * passage the model copies can be found again in the file, line by line.
 */
export function readMeetingCapture(raw: string, fallbackTitle: string): MeetingCapture {
  const { frontmatter, body, bodyStartLine } = splitFrontmatter(raw);
  const title = typeof frontmatter.title === "string" && frontmatter.title.trim() ? frontmatter.title.trim() : fallbackTitle;
  const lines = body
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l, i) => ({ text: redact(l.replace(/^\s*>\s?/, "")), line: bodyStartLine + i }));
  return { title, lines, queries: queriesOf(title, lines) };
}

function queriesOf(title: string, lines: readonly CaptureLine[]): string[] {
  const headings = lines.filter((l) => /^#{1,6}\s/.test(l.text)).map((l) => l.text.replace(/^#+\s*/, ""));
  const points = lines.filter((l) => /^\s*[-*]\s+\S/.test(l.text)).map((l) => l.text.replace(/^\s*[-*]\s+/, ""));
  const all = [title, ...headings, ...points].map((q) => q.trim().slice(0, MAX_QUERY_CHARS)).filter(Boolean);
  return [...new Set(all)].slice(0, MAX_QUERIES);
}

/** The capture in parts of at most `maxChars`, split between lines, so a long meeting is read whole. */
export function captureParts(lines: readonly CaptureLine[], maxChars: number): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let size = 0;
  for (const { text } of lines) {
    const line = text.length > maxChars ? text.slice(0, maxChars) : text;
    if (size + line.length + 1 > maxChars && current.length) {
      parts.push(current.join("\n"));
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.some((l) => l.trim())) parts.push(current.join("\n"));
  return parts;
}

/** Text compared as the owner would read it: case and spacing do not make two passages different. */
const norm = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * The first and last line of the file that hold a quoted passage, the
 * shortest run of lines that does; null when no run of lines holds it.
 */
export function quotedLines(lines: readonly CaptureLine[], quote: string): [number, number] | null {
  const q = norm(quote);
  if (!q) return null;
  const texts = lines.map((l) => norm(l.text));
  const holds = (from: number, to: number) => norm(texts.slice(from, to + 1).join(" ")).includes(q);
  for (let i = 0; i < texts.length; i++) {
    if (!texts[i]) continue;
    let length = 0;
    for (let j = i; j < texts.length; j++) {
      length += texts[j]!.length + 1;
      if (holds(i, j)) {
        let from = i;
        while (from < j && holds(from + 1, j)) from++;
        return [lines[from]!.line, lines[j]!.line];
      }
      // Past this point the run without line i is long enough on its own; a later start finds it.
      if (length - texts[i]!.length > q.length + 1) break;
    }
  }
  return null;
}
