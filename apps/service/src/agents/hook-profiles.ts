import { existsSync, readdirSync } from "node:fs";
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

export const HOOK_PROFILES: Record<string, HookProfile> = {
  "claude-code": claudeStyle,
  // Codex uses the same input fields and output shape as Claude Code.
  codex: { ...claudeStyle, locateTranscript: locateCodexRollout },
  antigravity,
};

export const HOOK_EVENTS: HookEvent[] = ["session-start", "pre-compact", "session-end", "turn-end"];
