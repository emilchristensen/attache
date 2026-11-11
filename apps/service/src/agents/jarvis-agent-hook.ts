/**
 * The command coding agents run from their hooks:
 *
 *   node jarvis-agent-hook.mjs <agent> <session-start|pre-compact|session-end> --state-dir <dir>
 *
 * session-start prints the session context the service last prepared: the
 * project's, when the session's folder is one of its repositories, otherwise
 * the global one.
 * pre-compact and session-end copy the transcript into the spool for the
 * service to ingest. It never talks to the network, never waits on the
 * service, and always exits 0: a broken hook must never break a session.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CAPTURE_EVENTS, spoolCapture, type HookEvent } from "./spool.ts";
import { contextFileFor } from "./context-files.ts";
import { HOOK_EVENTS, HOOK_PROFILES } from "./hook-profiles.ts";

const MAX_INPUT_BYTES = 1_000_000;

function readStdin(): Record<string, unknown> {
  try {
    const raw = readFileSync(0).subarray(0, MAX_INPUT_BYTES).toString("utf8");
    const parsed = raw.trim() ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function runHook(argv: string[], env: NodeJS.ProcessEnv = process.env): string {
  const [agent, event] = argv;
  const i = argv.indexOf("--state-dir");
  const stateDir = i >= 0 ? argv[i + 1] : env.JARVIS_STATE_DIR;
  const profile = agent ? HOOK_PROFILES[agent] : undefined;
  if (!agent || !profile || !stateDir || !HOOK_EVENTS.includes(event as HookEvent)) return "";
  // Sessions that tools start on their own (Jarvis's model calls, other Agent SDK scripts) are not the user's work.
  if (env.CLAUDE_INVOKED_BY || env.JARVIS_AGENT_HOOK_DISABLED) return "";
  const input = profile.parse(readStdin());
  if (event === "session-start") {
    // The session's own folder decides which project's context it gets; the hook never asks the service.
    const file = contextFileFor(stateDir, input.cwd ?? process.cwd());
    return existsSync(file) ? profile.sessionStartOutput(readFileSync(file, "utf8")) : "";
  }
  if (CAPTURE_EVENTS.includes(event as HookEvent) && input.capture !== false) {
    const sourcePath = input.transcriptPath ?? profile.locateTranscript?.(input.sessionId, env.HOME ?? "") ?? null;
    spoolCapture(stateDir, { agent, event: event as HookEvent, sessionId: input.sessionId, cwd: input.cwd, sourcePath });
  }
  return "";
}

const isMain = process.argv[1] && /jarvis-agent-hook\.mjs$|agents\/jarvis-agent-hook\.ts$/.test(process.argv[1]);
if (isMain) {
  try {
    const out = runHook(process.argv.slice(2));
    if (out) process.stdout.write(out + "\n");
  } catch (e) {
    // Never fail the session; leave a trace the service surfaces instead.
    try {
      const argv = process.argv.slice(2);
      const i = argv.indexOf("--state-dir");
      const stateDir = i >= 0 ? argv[i + 1] : process.env.JARVIS_STATE_DIR;
      if (stateDir) {
        mkdirSync(join(stateDir, "logs"), { recursive: true, mode: 0o700 });
        appendFileSync(join(stateDir, "logs", "agent-hook.log"), `${new Date().toISOString()} ${argv.slice(0, 2).join(" ")}: ${(e as Error).stack ?? String(e)}\n`);
      }
    } catch {
      // Nothing left to report to.
    }
  }
  process.exit(0);
}
