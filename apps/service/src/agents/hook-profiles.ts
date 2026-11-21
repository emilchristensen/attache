import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HookEvent } from "./spool.ts";

/**
 * What the hook script needs to know about each agent: how to read its hook
 * input and how to hand back session-start context. Kept dependency-free
 * because the hook script imports it.
 */
export interface HookInput {
  sessionId: string;
  cwd: string | null;
  transcriptPath: string | null;
  /** False when the agent says this event is not worth capturing (e.g. a Stop while still busy). */
  capture?: boolean;
}

export interface HookProfile {
  parse(payload: Record<string, unknown>): HookInput;
  /** stdout for a session-start hook that injects `context`. */
  sessionStartOutput(context: string): string;
  /** Find the transcript when the agent's hook input leaves it out. */
  locateTranscript?(sessionId: string, home: string): string | null;
  /** Wait, briefly, until the agent has written the transcript up to this hook (`payload` is the hook's input). */
  awaitTranscript?(path: string, event: HookEvent, payload: Record<string, unknown>): void;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/** Claude Code: snake_case input; SessionStart context via hookSpecificOutput.additionalContext. */
const claudeStyle: HookProfile = {
  parse: (p) => ({ sessionId: str(p.session_id) ?? "unknown", cwd: str(p.cwd), transcriptPath: str(p.transcript_path) }),
  sessionStartOutput: (context) => JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }),
};

/** Codex rollouts are `sessions/YYYY/MM/DD/rollout-<time>-<session id>.jsonl`; search the newest days first. */
function locateCodexRollout(sessionId: string, home: string): string | null {
  const root = join(process.env.CODEX_HOME || join(home, ".codex"), "sessions");
  if (!existsSync(root) || !/^[A-Za-z0-9-]+$/.test(sessionId)) return null;
  const suffix = `-${sessionId}.jsonl`;
  const desc = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort().reverse() : []);
  for (const y of desc(root))
    for (const m of desc(join(root, y)))
      for (const d of desc(join(root, y, m))) {
        const hit = desc(join(root, y, m, d)).find((f) => f.startsWith("rollout-") && f.endsWith(suffix));
        if (hit) return join(root, y, m, d, hit);
      }
  return null;
}

/**
 * Antigravity: camelCase input. Its Stop hook fires after every execution; only
 * a fully idle one marks a finished turn. The untruncated transcript, when it
 * exists next to the documented one, is preferred.
 */
const antigravity: HookProfile = {
  parse: (p) => {
    const documented = str(p.transcriptPath);
    const full = documented?.replace(/transcript\.jsonl$/, "transcript_full.jsonl");
    const workspaces = Array.isArray(p.workspacePaths) ? p.workspacePaths.filter((w): w is string => typeof w === "string") : [];
    return { sessionId: str(p.conversationId) ?? "unknown", cwd: workspaces[0] ?? null, transcriptPath: full && full !== documented && existsSync(full) ? full : documented, capture: p.fullyIdle !== false };
  },
  // Antigravity gets memory from an always-on rule file instead of a session-start hook.
  sessionStartOutput: () => "",
};

/** The tag around memory Attache injects, which transcript parsers strip (transcripts.ts). */
const memoryBlock = (context: string) => `<attache-memory>\n${context.trim()}\n</attache-memory>`;

/**
 * Copilot CLI's hooks Attache runs, by the event name in its hooks file
 * (sessionStart gives memory; the others save the session).
 */
export const COPILOT_HOOK_EVENTS: Record<string, HookEvent> = { sessionStart: "session-start", agentStop: "turn-end", preCompact: "pre-compact", sessionEnd: "session-end" };

/** How long a Copilot CLI hook waits for Copilot CLI to write the session up to it; it wrote within about 100 ms in every run seen. */
const COPILOT_WAIT_MS = 3_000;
const COPILOT_POLL_MS = 50;

/** `session-state/<session id>/events.jsonl` in Copilot CLI's home folder: `COPILOT_HOME`, else `~/.copilot`. */
function locateCopilotEvents(sessionId: string, home: string): string | null {
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return null;
  const root = process.env.COPILOT_HOME?.trim() || join(home, ".copilot");
  return join(root, "session-state", sessionId, "events.jsonl");
}

/**
 * Copilot CLI writes a session's events to events.jsonl in batches, shortly
 * after it starts a hook: when the hook starts, the turn that just ended is
 * not in the file yet. Its own `hook.start` event, which carries the hook's
 * input, comes after them, so once that is in the file the copy holds the
 * whole session so far. Copilot CLI does not write it for every hook (the
 * sessionEnd of a session /clear replaces), so the wait is bounded; then the
 * file holds everything up to the turn before, which the next hook saves.
 */
function awaitCopilotEvents(path: string, event: HookEvent, payload: Record<string, unknown>) {
  const hookType = Object.keys(COPILOT_HOOK_EVENTS).find((k) => COPILOT_HOOK_EVENTS[k] === event);
  const written = () => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return false;
    }
    return text.split("\n").some((line) => {
      if (!line.includes('"hook.start"')) return false;
      try {
        const e = JSON.parse(line) as { type?: unknown; data?: { hookType?: unknown; input?: { timestamp?: unknown; sessionId?: unknown } } };
        return e.type === "hook.start" && e.data?.hookType === hookType && e.data?.input?.timestamp === payload.timestamp && e.data?.input?.sessionId === payload.sessionId;
      } catch {
        return false;
      }
    });
  };
  const until = Date.now() + COPILOT_WAIT_MS;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  while (!written() && Date.now() < until) Atomics.wait(nap, 0, 0, COPILOT_POLL_MS);
}

/**
 * Copilot CLI: camelCase input (`sessionId`, `cwd`, `transcriptPath` on the
 * events that have it); a sessionStart command hook hands context back as one
 * JSON object with `additionalContext`, which Copilot CLI adds to the
 * conversation as a message of its own. A subagent's agentStop carries its
 * `agentId` and the parent session's transcript: never captured, the parent's
 * own hooks save it.
 */
const copilotCli: HookProfile = {
  parse: (p) => ({ sessionId: str(p.sessionId) ?? "unknown", cwd: str(p.cwd), transcriptPath: str(p.transcriptPath), capture: p.agentId === undefined || p.agentId === null }),
  sessionStartOutput: (context) => (context.trim() ? JSON.stringify({ additionalContext: memoryBlock(context) }) : ""),
  locateTranscript: locateCopilotEvents,
  awaitTranscript: awaitCopilotEvents,
};

export const HOOK_PROFILES: Record<string, HookProfile> = {
  "claude-code": claudeStyle,
  // Codex uses the same input fields and output shape as Claude Code.
  codex: { ...claudeStyle, locateTranscript: locateCodexRollout },
  antigravity,
  "copilot-cli": copilotCli,
};

export const HOOK_EVENTS: HookEvent[] = ["session-start", "pre-compact", "session-end", "turn-end"];
