import { clean, type ParsedSession, type Turn } from "./transcripts.ts";

/**
 * Copilot CLI sessions: `session-state/<session id>/events.jsonl` in its home
 * folder, which Attache's hooks copy into the spool. One event per line,
 * `{ id, timestamp, parentId, type, data, agentId? }`, starting with
 * `session.start` (`data.version`, `data.producer`). Copilot CLI appends to
 * the file for the whole life of a session, compactions and resumes
 * included, so each copy holds every earlier copy's events. The format is
 * Copilot CLI's internal one, undocumented; this parser follows what real
 * Copilot CLI 1.0.114 wrote.
 *
 * Only `user.message` (`data.content`, what the owner typed, not the
 * `transformedContent` Copilot CLI sends the model) and `assistant.message`
 * (`data.content`) are the conversation. Events with an `agentId` are a
 * subagent's, messages with a `source` (a hidden skill injection, another
 * agent's prompt), autopilot continuations and an assistant's thinking are
 * not the owner's or the assistant's words. Hooks (where Attache's memory
 * lands), tools, the system prompt, instructions, compaction summaries and
 * Copilot CLI's own bookkeeping are dropped by kind. Anything else (a format
 * version, producer, kind of event, or message shape this parser does not
 * know) yields no turns and names what could not be read, never a guess.
 */

/** events.jsonl format versions this parser understands (`session.start` `data.version`). */
const VERSIONS = new Set([1]);
/** Kinds of event that never hold the owner's or the assistant's words, by the part of the type before the dot. */
const SKIPPED_KINDS = new Set(["session", "hook", "tool", "subagent", "system", "skill", "instruction", "permission"]);
/** Events of the conversation's own kinds that are not its words. */
const SKIPPED_TYPES = new Set(["assistant.turn_start", "assistant.turn_end", "assistant.reasoning", "assistant.message_delta", "assistant.intent", "assistant.usage", "user.message_queued"]);
/** Phases of an assistant message: only its response is what it said. */
const PHASES = new Map<unknown, boolean>([
  [undefined, true],
  [null, true],
  ["response", true],
  ["thinking", false],
]);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

class Unreadable extends Error {}
function unreadable(why: string): never {
  throw new Unreadable(why);
}

const empty = (cwd: string | null = null, problem?: string): ParsedSession => ({ turns: [], title: null, cwd, startedAt: null, ...(problem ? { problem } : {}) });

/** The file's events; a last line Copilot CLI is still writing is left for the next copy. */
function eventsOf(raw: string): unknown[] {
  const lines = raw.split("\n");
  const last = lines.length - 1;
  return lines.flatMap((l, i) => {
    if (!l.trim()) return [];
    try {
      return [JSON.parse(l) as unknown];
    } catch {
      // Only a last line without its newline is still being written.
      if (i === last && i > 0) return [];
      unreadable("a line that is not JSON");
    }
  });
}

function turnOf(e: Record<string, unknown>): Turn | null {
  if (e.agentId !== undefined && e.agentId !== null) return null;
  const d = isObject(e.data) ? e.data : unreadable(`a ${String(e.type)} event without data`);
  const role = e.type === "user.message" ? "user" : "assistant";
  if (typeof d.content !== "string") unreadable(`a ${String(e.type)} event whose content is not text`);
  if (role === "user" && (d.source != null || d.isAutopilotContinuation === true)) return null;
  if (role === "assistant") {
    if (d.parentToolCallId != null) return null;
    if (!PHASES.has(d.phase)) unreadable(`an assistant message in phase ${JSON.stringify(d.phase)}`);
    if (!PHASES.get(d.phase)) return null;
  }
  const text = clean(d.content);
  return text ? { role, text, at: str(e.timestamp), id: str(e.id) ?? unreadable(`a ${String(e.type)} event without an id`) } : null;
}

export function parseCopilotCli(raw: string): ParsedSession {
  let list: unknown[];
  try {
    list = eventsOf(raw);
  } catch (e) {
    if (e instanceof Unreadable) return empty(null, `Copilot CLI events file with ${e.message}`);
    throw e;
  }
  if (!list.length) return empty();
  const first = list[0];
  if (!isObject(first) || first.type !== "session.start" || !isObject(first.data)) return empty(null, "Copilot CLI events file that does not start with session.start");
  const { version, producer, context } = first.data;
  if (!VERSIONS.has(version as number)) return empty(null, `Copilot CLI events format version ${JSON.stringify(version)}`);
  if (producer !== "copilot-agent") return empty(null, `Copilot CLI events file from producer ${JSON.stringify(producer)}`);
  const cwd = isObject(context) ? str(context.cwd) : null;
  const format = `Copilot CLI events format version ${String(version)}`;
  const turns: Turn[] = [];
  try {
    for (const e of list) {
      if (!isObject(e)) unreadable("a line that is not an event");
      if (typeof e.type !== "string") unreadable("an event without a type");
      if (e.type === "user.message" || e.type === "assistant.message") {
        const t = turnOf(e);
        if (t) turns.push(t);
        continue;
      }
      if (SKIPPED_TYPES.has(e.type) || SKIPPED_KINDS.has(e.type.split(".")[0]!)) continue;
      unreadable(`an event of type ${JSON.stringify(e.type)}`);
    }
  } catch (e) {
    if (e instanceof Unreadable) return empty(cwd, `${format} with ${e.message}`);
    throw e;
  }
  return { turns, title: null, cwd, startedAt: turns.find((t) => t.at)?.at ?? null };
}
