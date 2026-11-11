/**
 * Which Harness started a process, from the environment it gives the processes it starts.
 * Lets an MCP save cite the session without the agent having to name it.
 */
export function agentFromEnv(env: NodeJS.ProcessEnv): { agent: string; sessionId?: string } | null {
  const session = (agent: string, id: string | undefined) => ({ agent, ...(id ? { sessionId: id } : {}) });
  if (env.CLAUDECODE === "1") return session("claude-code", env.CLAUDE_CODE_SESSION_ID);
  if (env.CODEX_THREAD_ID) return session("codex", env.CODEX_THREAD_ID);
  if (env.ANTIGRAVITY_CONVERSATION_ID) return session("antigravity", env.ANTIGRAVITY_CONVERSATION_ID);
  return null;
}
