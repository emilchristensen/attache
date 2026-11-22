import { clean, type ParsedSession, type Turn } from "./transcripts.ts";

/**
 * Pi sessions, as Attache's Pi extension spools them. At the end of each run
 * (`agent_settled`), before each compaction and when a session closes, the
 * extension hands the hook script `ctx.sessionManager.getBranch()`: every
 * entry from the session's root to its current leaf, in this envelope. Pi
 * keeps compacted messages on the branch, so each snapshot holds the whole
 * conversation of that branch; branches the owner left with `/tree` are not
 * on it. Kept dependency-free: the extension's shape and this parser must
 * agree, and nothing else reads it.
 *
 * Only `message` entries with role `user` or `assistant` are the
 * conversation, and only their text: the system prompt, tool calls and
 * results, thinking, `!` commands, compaction and branch summaries, and every
 * extension's custom messages (Attache's memory among them) are dropped.
 * A skill's instructions that `/skill:name` puts into the owner's message are
 * stripped from it. Anything Pi might write that this parser does not know
 * (a session version, entry type or message role) yields no turns and names
 * what could not be read, never a guess.
 */
export interface PiSnapshot {
  attache: "pi-session";
  v: 1;
  /** Pi's session header: `{ type: "session", version, id, timestamp, cwd, parentSession? }`. */
  header: unknown;
  /**
   * For a session cloned or forked from another (`parentSession`): the last
   * entry of this branch that the parent session already has. Entries up to
   * it were saved with the parent; only what follows is this session's own.
   */
  forkedAt: string | null;
  entries: unknown;
}

/** Session file versions this parser understands. */
const VERSIONS = new Set([3]);
/** Entry types that are never the owner's or the assistant's words. */
const SKIPPED_ENTRIES = new Set(["thinking_level_change", "model_change", "usage", "compaction", "branch_summary", "custom", "custom_message", "context_edit", "label", "session_info"]);
/** Message roles that are never the owner's or the assistant's words. */
const SKIPPED_ROLES = new Set(["system", "toolResult", "bashExecution", "custom", "branchSummary", "compactionSummary"]);
/** What `/skill:name` puts ahead of the owner's own words. */
const SKILL = /^<skill name="[^"]*" location="[^"]*">\n[\s\S]*?\n<\/skill>(?:\n\n|$)/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

class Unreadable extends Error {}
function unreadable(why: string): never {
  throw new Unreadable(why);
}

/** The text blocks of a message's content; images and anything else are left out. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) unreadable("a message whose content is neither text nor a list");
  return content
    .filter((b): b is { type: "text"; text: string } => isObject(b) && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function turnsOf(entries: unknown[]): { turns: Turn[]; title: string | null } {
  const turns: Turn[] = [];
  let title: string | null = null;
  for (const e of entries) {
    if (!isObject(e) || typeof e.type !== "string") unreadable("an entry without a type");
    if (e.type === "session_info") title = str(e.name) ?? title;
    if (SKIPPED_ENTRIES.has(e.type)) continue;
    if (e.type !== "message") unreadable(`an entry of type ${JSON.stringify(e.type)}`);
    const id = str(e.id) ?? unreadable("a message entry without an id");
    const m = e.message;
    if (!isObject(m) || typeof m.role !== "string") unreadable("a message entry without a role");
    if (SKIPPED_ROLES.has(m.role)) continue;
    if (m.role !== "user" && m.role !== "assistant") unreadable(`a message with role ${JSON.stringify(m.role)}`);
    const raw = textOf(m.content);
    const text = clean(m.role === "user" ? raw.replace(SKILL, "") : raw);
    if (text) turns.push({ role: m.role, text, at: str(e.timestamp), id });
  }
  return { turns, title };
}

const empty = (problem?: string): ParsedSession => ({ turns: [], title: null, cwd: null, startedAt: null, ...(problem ? { problem } : {}) });

export function parsePi(raw: string): ParsedSession {
  let s: unknown;
  try {
    s = JSON.parse(raw);
  } catch {
    return empty("Pi session snapshot that is not JSON");
  }
  if (!isObject(s) || s.attache !== "pi-session" || s.v !== 1) return empty("Pi session snapshot in an unknown envelope");
  const snap = s as unknown as PiSnapshot;
  const header = snap.header;
  if (!isObject(header) || header.type !== "session") return empty("Pi session snapshot without a session header");
  if (!VERSIONS.has(header.version as number)) return empty(`Pi session format version ${JSON.stringify(header.version)}`);
  const format = `Pi session format version ${String(header.version)}`;
  if (!Array.isArray(snap.entries)) return empty(`${format} snapshot without an entry list`);
  let entries = snap.entries as unknown[];
  if (snap.forkedAt !== null && snap.forkedAt !== undefined) {
    const i = entries.findIndex((e) => isObject(e) && e.id === snap.forkedAt);
    if (i < 0) return empty(`${format} snapshot of a forked session whose fork point is not on its branch`);
    entries = entries.slice(i + 1);
  }
  let parsed: { turns: Turn[]; title: string | null };
  try {
    parsed = turnsOf(entries);
  } catch (e) {
    if (e instanceof Unreadable) return empty(`${format} snapshot with ${e.message}`);
    throw e;
  }
  const createdAt = parsed.turns.length && !header.parentSession ? str(header.timestamp) : null;
  return { turns: parsed.turns, title: parsed.title, cwd: str(header.cwd), startedAt: parsed.turns.find((t) => t.at)?.at ?? null, ...(createdAt ? { createdAt } : {}) };
}
