import type { MemorySaveInput } from "@jarvis/contracts";
import { agentFromEnv } from "../cli/agent-env.ts";

export type SaveOrigin = NonNullable<MemorySaveInput["origin"]>;

/**
 * The names Harnesses report when they connect, for those that do not
 * identify themselves through the environment they give the server.
 */
const CLIENT_HARNESS: Record<string, string> = {
  "claude-code": "claude-code",
  "claude-ai": "claude-desktop",
  "codex-mcp-client": "codex",
  codex: "codex",
  antigravity: "antigravity",
};

const AGENT_MAX = 40;

/**
 * Which Harness and session a save comes from. A Harness that starts the
 * server per session names both in the environment it gives the server, which
 * is the more precise answer; otherwise the name it reported when it
 * connected identifies the Harness, without a session.
 */
export function saveOrigin(env: NodeJS.ProcessEnv, client: { name: string } | undefined, cwd: string): SaveOrigin {
  const fromEnv = agentFromEnv(env);
  const agent = fromEnv?.agent ?? harnessFromClient(client?.name);
  return { agent, ...(fromEnv?.sessionId ? { sessionId: fromEnv.sessionId.slice(0, 200) } : {}), cwd: cwd.slice(0, 2000) };
}

function harnessFromClient(name: string | undefined): string {
  const reported = name?.trim().toLowerCase() ?? "";
  const known = CLIENT_HARNESS[reported];
  if (known) return known;
  const slug = reported.replace(/[^a-z0-9]+/g, "-").slice(0, AGENT_MAX).replace(/^-+|-+$/g, "");
  return slug || "mcp-client";
}
