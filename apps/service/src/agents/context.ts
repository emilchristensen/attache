/**
 * The memory block a coding agent receives when a session starts. It goes
 * into every session on the machine, so it stays small: who the user is, an
 * index of what Jarvis remembers, the latest session logs, and how to search
 * for anything deeper. Built by the service; the hook only prints it.
 */
export interface ContextInput {
  now: Date;
  dataFolder: string;
  identity: { name: string; email?: string; role?: string } | null;
  /** Most recently updated first; `gist` is the note's first current fact. */
  memory: Array<{ type: string; title: string; gist?: string }>;
  recentLogs: Array<{ date: string; body: string }>;
  searchCommand: string;
}

/** Notes per type whose first fact (the gist) every new session reads. */
export const MAX_DETAILED_PER_TYPE = 15;
const MAX_TITLES_PER_TYPE = 40;
const MAX_GIST_CHARS = 120;
const MAX_LOG_CHARS = 6000;
export const TYPE_LABEL: Record<string, string> = { person: "People", project: "Projects", decision: "Decisions", note: "Notes" };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function buildSessionContext(c: ContextInput): string {
  const out: string[] = [`## Jarvis memory`, "", `Data folder: ${c.dataFolder}`, `Now: ${c.now.toLocaleString("sv-SE", { dateStyle: "short", timeStyle: "short" })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`];
  if (c.identity) {
    out.push("", "### Who you are working with", "", `- Name: ${c.identity.name}`);
    if (c.identity.email) out.push(`- Email: ${c.identity.email}`);
    if (c.identity.role) out.push(`- Role: ${c.identity.role}`);
  }
  const byType = new Map<string, ContextInput["memory"]>();
  for (const m of c.memory) byType.set(m.type, [...(byType.get(m.type) ?? []), m]);
  if (byType.size) {
    out.push("", "### What Jarvis remembers", "", "Curated notes in the data folder's `memory/`, most recently updated first.");
    for (const [type, notes] of byType) {
      out.push("", `${TYPE_LABEL[type] ?? type}:`);
      for (const n of notes.slice(0, MAX_DETAILED_PER_TYPE)) out.push(`- ${n.title}${n.gist ? `: ${clip(n.gist, MAX_GIST_CHARS)}` : ""}`);
      const rest = notes.slice(MAX_DETAILED_PER_TYPE);
      const named = rest.slice(0, MAX_TITLES_PER_TYPE);
      if (named.length) out.push(`- Also: ${named.map((n) => n.title).join("; ")}${rest.length > named.length ? `; and ${rest.length - named.length} more` : ""}`);
    }
  }
  let budget = MAX_LOG_CHARS;
  const logs = c.recentLogs.flatMap((l) => {
    if (budget <= 0) return [];
    // Session logs are their own documents: nest their headings under this one and make links absolute.
    const body = l.body
      .trim()
      .replace(/^## /gm, "##### ")
      .replace(/\]\(transcripts\//g, `](${c.dataFolder}/evidence/sessions/transcripts/`)
      .slice(0, budget);
    budget -= body.length;
    return body ? [`#### ${l.date}\n\n${body}`] : [];
  });
  if (logs.length) out.push("", "### Recent agent sessions", "", ...logs);
  out.push("", "### Deeper recall", "", "Only this index is loaded. When a topic matters, search Jarvis instead of guessing; results cite file and line in the data folder:", "", `    ${c.searchCommand} "your query"`);
  return out.join("\n") + "\n";
}
