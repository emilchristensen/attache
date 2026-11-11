import { parseStateLine, splitFrontmatter, type StateEntry } from "../../memory/markdown.ts";

/** A Current State entry with any indented lines under it, exactly as the file has it. */
export interface FactBlock {
  /** The subject, case-folded: two entries with the same key are the same fact. */
  readonly key: string;
  readonly entry: Omit<StateEntry, "line">;
  readonly lines: readonly string[];
}

/** A History item: one `- …` line with any indented lines under it. */
export type HistoryItem = readonly string[];

/**
 * A note taken apart for merging. Facts and History merge by their own rules;
 * everything else is prose, which keeps a placeholder line where the facts
 * and the History items were, so it can be merged as text and put back together.
 */
export interface NoteParts {
  /** Null when the note has no frontmatter. */
  readonly frontmatter: Readonly<Record<string, unknown>> | null;
  /** The frontmatter's YAML as written, so an unchanged frontmatter is kept byte for byte. */
  readonly frontmatterText: string | null;
  readonly facts: readonly FactBlock[];
  readonly history: readonly HistoryItem[];
  readonly prose: string;
}

/** Lines that stand for the facts and the History items inside `NoteParts.prose`. A note never holds a NUL. */
export const FACTS_PLACEHOLDER = "\u0000jarvis:facts\u0000";
export const HISTORY_PLACEHOLDER = "\u0000jarvis:history\u0000";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
const CONTINUATION_RE = /^\s+\S/;
const COMMENT_RE = /^\s*<!--.*-->\s*$/;

type Section = "state" | "history" | "other";

function sectionOf(heading: string): Section {
  const h = heading.trim().toLowerCase();
  return h === "current state" ? "state" : h === "history" ? "history" : "other";
}

/** Where a list goes in a section that has none: after the heading and the comment lines under it. */
function emptyListAt(out: readonly string[], headingAt: number): number {
  let at = headingAt + 1;
  while (at < out.length && COMMENT_RE.test(out[at]!)) at++;
  return at;
}

/** Takes a note apart. Null when its frontmatter cannot be read, so no rule guesses at it. */
export function splitNote(raw: string): NoteParts | null {
  const fm = splitFrontmatter(raw);
  if (fm.error) return null;
  const frontmatterText = FRONTMATTER_RE.exec(raw)?.[1] ?? null;
  // Built line by line here, handed out read-only.
  const facts: Array<{ key: string; entry: FactBlock["entry"]; lines: string[] }> = [];
  const history: string[][] = [];
  const out: string[] = [];
  let section: Section = "other";
  let headingAt = -1;
  let placed = false;
  let open: "fact" | "history" | null = null;
  let inFence = false;

  const closeSection = () => {
    if (section !== "other" && !placed) out.splice(emptyListAt(out, headingAt), 0, section === "state" ? FACTS_PLACEHOLDER : HISTORY_PLACEHOLDER);
  };
  const place = (placeholder: string) => {
    if (!placed) out.push(placeholder);
    placed = true;
  };

  for (const line of fm.body.split("\n")) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    const heading = inFence ? null : HEADING_RE.exec(line);
    if (heading) {
      closeSection();
      section = sectionOf(heading[2]!);
      headingAt = out.length;
      placed = false;
      open = null;
      out.push(line);
      continue;
    }
    if (open && CONTINUATION_RE.test(line)) {
      (open === "fact" ? facts[facts.length - 1]!.lines : history[history.length - 1]!).push(line);
      continue;
    }
    open = null;
    const entry = section === "state" && !inFence ? parseStateLine(line) : null;
    if (entry) {
      place(FACTS_PLACEHOLDER);
      facts.push({ key: entry.subject.toLowerCase(), entry, lines: [line] });
      open = "fact";
    } else if (section === "history" && !inFence && /^- /.test(line)) {
      place(HISTORY_PLACEHOLDER);
      history.push([line]);
      open = "history";
    } else {
      out.push(line);
    }
  }
  closeSection();
  return { frontmatter: frontmatterText === null ? null : fm.frontmatter, frontmatterText, facts, history, prose: out.join("\n") };
}

/** The parts of a note that did not exist yet, for two notes created apart. */
export const NO_NOTE: NoteParts = Object.freeze({ frontmatter: null, frontmatterText: null, facts: [], history: [], prose: "" });

function putAt(lines: readonly string[], placeholder: string, items: readonly string[], fallback: (lines: string[]) => string[]): string[] {
  const first = lines.indexOf(placeholder);
  if (first < 0) return items.length ? fallback([...lines]) : [...lines];
  return lines.flatMap((l, i) => (l !== placeholder ? [l] : i === first ? [...items] : []));
}

/** Puts a note back together from merged parts. */
export function joinNote(parts: { frontmatterText: string | null; facts: readonly FactBlock[]; history: readonly HistoryItem[]; prose: string }): string {
  const factLines = parts.facts.flatMap((f) => f.lines);
  const historyLines = parts.history.flatMap((h) => h);
  const withFacts = putAt(parts.prose.split("\n"), FACTS_PLACEHOLDER, factLines, (lines) => {
    const h1 = lines.findIndex((l) => /^#\s+/.test(l));
    lines.splice(h1 + 1, 0, "", "## Current State", ...factLines);
    return lines;
  });
  const body = putAt(withFacts, HISTORY_PLACEHOLDER, historyLines, (lines) => {
    while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
    return [...lines, "", "## History", ...historyLines, ""];
  }).join("\n");
  return parts.frontmatterText === null ? body : `---\n${parts.frontmatterText}\n---\n${body}`;
}
