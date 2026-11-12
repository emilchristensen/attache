import { join } from "node:path";
import { plural } from "@jarvis/contracts";
import { isPastReview, unverifiedLabel } from "../memory/review-date.ts";
import type { SearchCommand } from "./search-command.ts";

/**
 * The memory block a Harness receives when a session starts. Built by the
 * service; the hook only prints it.
 *
 * Every session gets who the owner is, a short index of note titles and how
 * to search. A session in a known project also gets that project's full
 * current state, the decisions and people linked to it and its recent
 * session-log entries. The whole stays within about 8 KB; what does not fit
 * is cut in `CUT_ORDER`, and the context says what was cut.
 */
export interface ContextInput {
  now: Date;
  dataFolder: string;
  identity: { name: string; email?: string; role?: string } | null;
  /** Every curated note, most recently updated first. */
  notes: ReadonlyArray<{ type: string; title: string }>;
  searchCommand: SearchCommand;
  /** The project whose repository the session runs in; absent in the global context. */
  project?: ProjectSection;
}

export interface ContextFact {
  subject: string;
  date: string;
  review?: string;
  value: string;
}

export interface ProjectSection {
  title: string;
  /** Absolute path of the project note. */
  path: string;
  state: readonly ContextFact[];
  /** Decisions and people linked to the project, most recently updated first; `relPath` inside the data folder. */
  linked: ReadonlyArray<{ type: string; title: string; relPath: string; state: readonly ContextFact[] }>;
  /** The project's session-log entries, newest first. */
  sessions: ReadonlyArray<{ date: string; heading: string; body: string }>;
}

/** The size the context is cut to, in bytes of UTF-8. Only the project's own facts are never cut. */
export const CONTEXT_BUDGET_BYTES = 8 * 1024;
export const MAX_TITLES_PER_TYPE = 30;
/** A linked note's fact longer than this is clipped; the note is one `read` away. */
const MAX_LINKED_FACT_CHARS = 300;
export const TYPE_LABEL: Record<string, string> = { person: "People", project: "Projects", decision: "Decisions", note: "Notes" };

/** How much of each cuttable part is shown. */
interface Shown {
  /** Note titles per type in the index. */
  titles: number;
  /** The newest project session-log entries. */
  sessions: number;
  /** The most recently updated linked notes shown with their facts. */
  linkedFacts: number;
  /** The most recently updated linked notes shown at all. */
  linked: number;
}

/**
 * What is cut, first to last, until the context fits: index titles (the
 * longest list first, down to counts per type), then the project's oldest
 * session-log entries, then the facts of the least recently updated linked
 * notes, then those notes themselves.
 */
const CUT_ORDER: ReadonlyArray<(s: Shown) => Shown | null> = [
  (s) => (s.titles > 0 ? { ...s, titles: s.titles - 1 } : null),
  (s) => (s.sessions > 0 ? { ...s, sessions: s.sessions - 1 } : null),
  (s) => (s.linkedFacts > 0 ? { ...s, linkedFacts: s.linkedFacts - 1 } : null),
  (s) => (s.linked > 0 ? { ...s, linked: s.linked - 1 } : null),
];

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

export function buildSessionContext(c: ContextInput): string {
  const p = c.project;
  const all: Shown = { titles: MAX_TITLES_PER_TYPE, sessions: p?.sessions.length ?? 0, linkedFacts: p?.linked.length ?? 0, linked: p?.linked.length ?? 0 };
  let shown = all;
  let text = render(c, shown, all);
  while (bytes(text) > CONTEXT_BUDGET_BYTES) {
    const next = CUT_ORDER.map((cut) => cut(shown)).find((s) => s !== null);
    if (!next) break;
    shown = next;
    text = render(c, shown, all);
  }
  return text;
}

function render(c: ContextInput, shown: Shown, all: Shown): string {
  const out = header(c);
  if (c.project) out.push(...projectLines(c.project, shown, c));
  out.push(...indexLines(c.notes, shown.titles));
  out.push("", "### Deeper recall", "", "Nothing else from the Brain is loaded. When a topic matters, search Jarvis instead of guessing; results cite file and line in the data folder:", "", `    ${c.searchCommand.line} "your query"`);
  if (c.searchCommand.powershell) out.push("", "In PowerShell, start it with the call operator:", "", `    ${c.searchCommand.powershell} "your query"`);
  const cut = cutNotice(shown, all);
  if (cut) out.push("", cut);
  return out.join("\n") + "\n";
}

function header(c: ContextInput): string[] {
  const out = [`## Jarvis memory`, "", `Data folder: ${c.dataFolder}`, `Now: ${c.now.toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`];
  if (c.identity) {
    out.push("", "### Who you are working with", "", `- Name: ${c.identity.name}`);
    if (c.identity.email) out.push(`- Email: ${c.identity.email}`);
    if (c.identity.role) out.push(`- Role: ${c.identity.role}`);
  }
  return out;
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** ` (unverified: …)` after a fact past its Review date, so a Harness does not repeat it as current. */
const unverified = (review: string | undefined, now: Date) => (review && isPastReview(review, now) ? ` (${unverifiedLabel(review)})` : "");

const factLine = (f: ContextFact, now: Date, maxChars = Infinity) => `- **${f.subject}** (${f.date}): ${clip(oneLine(f.value), maxChars)}${unverified(f.review, now)}`;

function projectLines(p: ProjectSection, shown: Shown, c: ContextInput): string[] {
  const out = ["", `### This session's project: ${p.title}`, "", `This session runs in one of the project's repositories. Its note: ${p.path}`];
  if (p.state.length) out.push("", ...p.state.map((f) => factLine(f, c.now)));
  const linked = p.linked.slice(0, shown.linked).map((n, i) => ({ ...n, withFacts: i < shown.linkedFacts }));
  for (const [type, heading] of [
    ["decision", "Decisions"],
    ["person", "People"],
  ] as const) {
    const notes = linked.filter((n) => n.type === type);
    if (!notes.length) continue;
    out.push("", `#### ${heading}`, "");
    for (const n of notes) out.push(`- **${n.title}** — ${n.relPath}`, ...(n.withFacts ? n.state.map((f) => `  ${factLine(f, c.now, MAX_LINKED_FACT_CHARS)}`) : []));
  }
  const sessions = p.sessions.slice(0, shown.sessions);
  if (sessions.length) {
    out.push("", "#### Recent sessions in this project");
    for (const s of sessions) {
      // Session logs are their own documents: nest their headings under this one and make links absolute,
      // in this operating system's form and in angle brackets, so a folder with spaces still makes one link.
      const body = s.body.replace(/^#{1,5} /gm, "###### ").replace(/\]\(transcripts\/([^)\s]+)\)/g, (_, rest: string) => `](<${join(c.dataFolder, "evidence", "sessions", "transcripts", ...rest.split("/"))}>)`);
      out.push("", `##### ${s.date} ${s.heading}`, "", body);
    }
  }
  return out;
}

function indexLines(notes: ContextInput["notes"], perType: number): string[] {
  if (!notes.length) return [];
  const byType = new Map<string, string[]>();
  for (const n of notes) byType.set(n.type, [...(byType.get(n.type) ?? []), n.title]);
  const out = ["", "### What Jarvis remembers", "", "Curated notes in the data folder's `memory/`, most recently updated first. Search reaches every one of them.", ""];
  for (const [type, titles] of byType) {
    const named = titles.slice(0, perType);
    const more = titles.length - named.length;
    const list = named.length ? `: ${named.join("; ")}${more ? `; and ${more} more` : ""}` : "";
    out.push(`- ${TYPE_LABEL[type] ?? type} (${titles.length})${list}`);
  }
  return out;
}

function cutNotice(shown: Shown, all: Shown): string | null {
  const parts = [
    all.sessions > shown.sessions ? plural(all.sessions - shown.sessions, "older session entry", "older session entries") : null,
    shown.linked > shown.linkedFacts ? `the facts of ${plural(shown.linked - shown.linkedFacts, "linked note", "linked notes")}` : null,
    all.linked > shown.linked ? plural(all.linked - shown.linked, "linked note", "linked notes") : null,
  ].filter(Boolean);
  return parts.length ? `Cut to stay within about 8 KB: ${parts.join(", ")}. Search for them.` : null;
}
