/**
 * The command each Harness runs from its hooks:
 *
 *   node attache-agent-hook.mjs <agent> <session-start|pre-compact|session-end> --state-dir <dir>
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
import { currentOs } from "../platform/os.ts";
import { platformLocations } from "../platform/locations.ts";

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

/**
 * The session context for a session in `folder`, the way the session-start
 * hook prints it: the project's when the folder is one of its repositories,
 * otherwise the global one; null when there is none, or for sessions tools
 * start on their own. Attache's Pi extension imports this to read memory
 * fresh before each model call.
 */
export function sessionContext(stateDir: string, folder: string | null, env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLAUDE_INVOKED_BY || env.ATTACHE_AGENT_HOOK_DISABLED) return null;
  const file = contextFileFor(stateDir, folder ?? process.cwd());
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

export function runHook(argv: string[], env: NodeJS.ProcessEnv = process.env): string {
  const [agent, event] = argv;
  const i = argv.indexOf("--state-dir");
  const stateDir = i >= 0 ? argv[i + 1] : env.ATTACHE_STATE_DIR;
  const profile = agent ? HOOK_PROFILES[agent] : undefined;
  if (!agent || !profile || !stateDir || !HOOK_EVENTS.includes(event as HookEvent)) return "";
  // Sessions that tools start on their own (Attache's model calls, other Agent SDK scripts) are not the user's work.
  if (env.CLAUDE_INVOKED_BY || env.ATTACHE_AGENT_HOOK_DISABLED) return "";
  const input = profile.parse(readStdin());
  if (event === "session-start") {
    // The session's own folder decides which project's context it gets; the hook never asks the service.
    const context = sessionContext(stateDir, input.cwd, env);
    return context === null ? "" : profile.sessionStartOutput(context);
  }
  if (CAPTURE_EVENTS.includes(event as HookEvent) && input.capture !== false) {
    const sourcePath = input.transcriptPath ?? profile.locateTranscript?.(input.sessionId, platformLocations(currentOs(), env).home) ?? null;
    spoolCapture(stateDir, { agent, event: event as HookEvent, sessionId: input.sessionId, cwd: input.cwd, sourcePath });
  }
  return "";
}

const isMain = process.argv[1] && /attache-agent-hook\.mjs$|agents[\\/]attache-agent-hook\.ts$/.test(process.argv[1]);
if (isMain) {
  try {
    const out = runHook(process.argv.slice(2));
    if (out) process.stdout.write(out + "\n");
  } catch (e) {
    // Never fail the session; leave a trace the service surfaces instead.
    try {
      const argv = process.argv.slice(2);
      const i = argv.indexOf("--state-dir");
      const stateDir = i >= 0 ? argv[i + 1] : process.env.ATTACHE_STATE_DIR;
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
