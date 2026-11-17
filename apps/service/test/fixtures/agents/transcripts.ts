/**
 * TEST-ONLY synthetic transcripts in each agent's on-disk shape. The Claude
 * Code and Codex shapes match real files on the development Mac; the
 * Antigravity shape follows community write-ups (see research/).
 */
const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

export function claudeTranscript(sessionId: string, cwd: string, exchanges: Array<[string, string]>): string {
  const rows: unknown[] = [{ type: "queue-operation", operation: "enqueue", sessionId }];
  exchanges.forEach(([user, assistant], i) => {
    const at = new Date(Date.UTC(2026, 9, 2, 9, i * 2)).toISOString();
    rows.push({ type: "user", sessionId, cwd, timestamp: at, isSidechain: false, message: { role: "user", content: `${user}\n<system-reminder>injected context that must not be archived</system-reminder>` } });
    rows.push({ type: "assistant", sessionId, cwd, timestamp: at, isSidechain: false, message: { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } });
    rows.push({ type: "user", sessionId, cwd, timestamp: at, isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "secret-looking tool output" }] } });
    rows.push({ type: "assistant", sessionId, cwd, timestamp: at, isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: assistant }] } });
    rows.push({ type: "assistant", sessionId, cwd, timestamp: at, isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] } });
  });
  rows.push({ type: "ai-title", sessionId, aiTitle: "Fixture session" });
  return jsonl(rows);
}

export function codexRollout(sessionId: string, cwd: string, exchanges: Array<[string, string]>): string {
  const rows: unknown[] = [
    { timestamp: "2026-10-02T09:00:00.000Z", type: "session_meta", payload: { id: sessionId, session_id: sessionId, cwd, timestamp: "2026-10-02T09:00:00.000Z" } },
    { timestamp: "2026-10-02T09:00:00.100Z", type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "## Attache memory\nalready injected" }] } },
    { timestamp: "2026-10-02T09:00:00.200Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context>\n<cwd>${cwd}</cwd>\n</environment_context>` }] } },
  ];
  exchanges.forEach(([user, assistant], i) => {
    const at = new Date(Date.UTC(2026, 9, 2, 9, 1 + i * 2)).toISOString();
    rows.push({ timestamp: at, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: user }] } });
    rows.push({ timestamp: at, type: "response_item", payload: { type: "function_call", name: "shell", arguments: "{}" } });
    rows.push({ timestamp: at, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: assistant }], phase: "final_answer" } });
  });
  return jsonl(rows);
}

export function antigravityTranscript(exchanges: Array<[string, string]>): string {
  const rows: unknown[] = [];
  exchanges.forEach(([user, assistant], i) => {
    const at = new Date(Date.UTC(2026, 9, 2, 9, i * 2)).toISOString();
    rows.push({ step_index: i * 3, source: "USER_EXPLICIT", type: "USER_INPUT", status: "DONE", created_at: at, content: user });
    rows.push({ step_index: i * 3 + 1, source: "SYSTEM", type: "EPHEMERAL", status: "DONE", created_at: at, content: "system note" });
    rows.push({ step_index: i * 3 + 2, source: "MODEL", type: "PLANNER_RESPONSE", status: "DONE", created_at: at, content: assistant, thinking: "private", tool_calls: [] });
  });
  return jsonl(rows);
}
