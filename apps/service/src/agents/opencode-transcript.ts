import { clean, type ParsedSession, type Turn } from "./transcripts.ts";

/**
 * OpenCode sessions, as Attache's OpenCode plugin spools them. OpenCode keeps
 * sessions in its own database, which is not a public interface, so the
 * plugin asks OpenCode for a session's messages through its plugin API at
 * each turn's end and before each compaction, and spools them in this
 * envelope. Kept dependency-free: the plugin's shape and this parser must
 * agree, and nothing else reads it.
 *
 * Shapes:
 * - `v1-messages`: OpenCode 1 `client.session.messages`, `[{ info, parts }]`,
 *   the whole session.
 * - `v2-context`: OpenCode 2 `ctx.session.context`, typed messages since the
 *   last compaction only.
 *
 * Each turn carries its OpenCode message id, so the service joins snapshots
 * that each hold part of a session. Anything not recognisably one of these
 * shapes yields no turns and names what could not be read, never a guess.
 */
export interface OpenCodeSnapshot {
  attache: "opencode-session";
  v: 1;
  opencode: number;
  shape: string;
  sessionID: string;
  /** Set for a subagent's session: a side-chain, never the owner's conversation. */
  parentID: string | null;
  title: string | null;
  created?: unknown;
  directory: string | null;
  messages: unknown;
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const iso = (ms: unknown) => (typeof ms === "number" && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);

class Unreadable extends Error {}
function unreadable(why: string): never {
  throw new Unreadable(why);
}

/** The text blocks of a part list, skipping text OpenCode adds itself (`synthetic`) or leaves out of the conversation (`ignored`). */
function textParts(parts: unknown[]): string {
  return parts
    .filter((p): p is { type: "text"; text: string } => isObject(p) && p.type === "text" && typeof p.text === "string" && !p.synthetic && !p.ignored)
    .map((p) => p.text)
    .join("\n");
}

/**
 * OpenCode 1. Its compaction writes a user message with a `compaction` part
 * and an assistant summary (`summary: true`); an automatic compaction can
 * then replay the owner's last message as a new copy and add a synthetic
 * "Continue…" message. None of those are the owner's or the assistant's words.
 */
function v1Turns(messages: unknown[]): Turn[] {
  const turns: Turn[] = [];
  let lastUserText: string | null = null;
  let afterCompaction = false;
  for (const m of messages) {
    if (!isObject(m) || !isObject(m.info) || !Array.isArray(m.parts)) unreadable("a message without info and parts");
    const { info, parts } = m as { info: Record<string, unknown>; parts: unknown[] };
    const role = info.role;
    const id = str(info.id) ?? unreadable("a message without an id");
    if (role !== "user" && role !== "assistant") unreadable(`a message with role ${JSON.stringify(role)}`);
    const time = isObject(info.time) ? info.time : {};
    if (role === "user") {
      const compaction = parts.find((p): p is Record<string, unknown> => isObject(p) && p.type === "compaction");
      if (compaction) {
        afterCompaction = compaction.auto === true && compaction.overflow === true;
        continue;
      }
      const text = clean(textParts(parts));
      if (!text) continue;
      // The copy of the owner's last message that an automatic compaction replays.
      if (afterCompaction && text === lastUserText) {
        afterCompaction = false;
        continue;
      }
      afterCompaction = false;
      lastUserText = text;
      turns.push({ role, text, at: iso(time.created), id });
      continue;
    }
    // A compaction summary, or an answer OpenCode is still writing.
    if (info.summary === true || time.completed === undefined) continue;
    const text = clean(textParts(parts));
    if (text) turns.push({ role, text, at: iso(time.created), completedAt: iso(time.completed), id });
  }
  return turns;
}

/** OpenCode 2 message types that are never the owner's or the assistant's words. */
const V2_SKIPPED = new Set(["synthetic", "system", "skill", "shell", "compaction", "idle", "agent-switched", "model-switched", "location-switched"]);

function v2ContextTurns(messages: unknown[]): Turn[] {
  const turns: Turn[] = [];
  for (const m of messages) {
    if (!isObject(m) || typeof m.type !== "string") unreadable("a message without a type");
    const msg = m as Record<string, unknown>;
    if (V2_SKIPPED.has(msg.type as string)) continue;
    if (msg.type !== "user" && msg.type !== "assistant") unreadable(`a message of type ${JSON.stringify(msg.type)}`);
    const id = str(msg.id) ?? unreadable("a message without an id");
    const time = isObject(msg.time) ? msg.time : {};
    if (msg.type === "user") {
      if (typeof msg.text !== "string") unreadable("a user message without text");
      const text = clean(msg.text as string);
      if (text) turns.push({ role: "user", text, at: iso(time.created), id });
      continue;
    }
    if (!Array.isArray(msg.content)) unreadable("an assistant message without content");
    if (time.completed === undefined) continue;
    const text = clean(textParts(msg.content as unknown[]));
    if (text) turns.push({ role: "assistant", text, at: iso(time.created), completedAt: iso(time.completed), id });
  }
  return turns;
}

const SHAPES = new Map([["v1-messages", v1Turns], ["v2-context", v2ContextTurns]]);

const empty = (problem?: string): ParsedSession => ({ turns: [], title: null, cwd: null, startedAt: null, ...(problem ? { problem } : {}) });

export function parseOpenCode(raw: string): ParsedSession {
  let s: unknown;
  try {
    s = JSON.parse(raw);
  } catch {
    return empty("OpenCode session snapshot that is not JSON");
  }
  if (!isObject(s) || s.attache !== "opencode-session" || s.v !== 1) return empty("OpenCode session snapshot in an unknown envelope");
  const snap = s as unknown as OpenCodeSnapshot;
  const format = `OpenCode ${String(snap.opencode)} ${String(snap.shape)}`;
  const shape = SHAPES.get(snap.shape);
  if (!shape) return empty(`unknown OpenCode format ${JSON.stringify(format)}`);
  // A subagent's session: a side-chain, not the owner's conversation.
  if (snap.parentID) return empty();
  if (!Array.isArray(snap.messages)) return empty(`${format} snapshot without a message list`);
  let turns: Turn[];
  try {
    turns = shape(snap.messages);
  } catch (e) {
    if (e instanceof Unreadable) return empty(`${format} snapshot with ${e.message}`);
    throw e;
  }
  const createdAt = iso(snap.created) ?? str(snap.created);
  return { turns, title: str(snap.title), cwd: str(snap.directory), startedAt: turns.find((t) => t.at)?.at ?? null, ...(createdAt ? { createdAt } : {}) };
}
