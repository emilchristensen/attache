/**
 * Which coding agent ran a command, from the environment it gives its shell.
 * Lets `jarvis save` cite the session without the skill having to know.
 */
export function agentFromEnv(env: NodeJS.ProcessEnv): { agent: string; sessionId?: string } | null {
  const session = (agent: string, id: string | undefined) => ({ agent, ...(id ? { sessionId: id } : {}) });
  if (env.CLAUDECODE === "1") return session("claude-code", env.CLAUDE_CODE_SESSION_ID);
  if (env.CODEX_THREAD_ID) return session("codex", env.CODEX_THREAD_ID);
  if (env.ANTIGRAVITY_CONVERSATION_ID) return session("antigravity", env.ANTIGRAVITY_CONVERSATION_ID);
  return null;
}
