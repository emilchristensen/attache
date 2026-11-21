/**
 * TEST-ONLY Copilot CLI `session-state/<id>/events.jsonl` files. The events are
 * the shapes real Copilot CLI 1.0.114 wrote in an isolated home with a
 * stand-in model (probe-108): a tool reading a file, a subagent run through
 * the task tool, /compact, a resume, Attache's sessionStart hook output.
 * Trimmed to the fields that matter, with made-up ids and text.
 */

export const SECRET = "sk-live-abcdef1234567890";
/** Plain text only tool output holds: redaction never rewrites it, so finding it anywhere proves tool output leaked. */
export const TOOL_OUTPUT = "TOOL-OUTPUT-7731";
/** Plain text only Attache's injected memory holds. */
export const MEMORY = "MEMORY-ORION-4410";
/** Plain text only a subagent's text holds. */
export const SIDE = "SIDE-CHAIN-9902";

export const SESSION = "6128c6ac-b9e7-479c-acc8-6918e02e109b";
export const SUBAGENT = "3879bcc5-1220-473e-beb5-cdae729e1f0f";

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`;
export const iso = (s: number) => new Date(1795294231000 + s * 1000).toISOString();

export type CopilotEvent = { id: string; timestamp: string; parentId: string | null; type: string; data: Record<string, unknown>; agentId?: string };
export const event = (type: string, at: number, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): CopilotEvent => ({ id: uuid(), timestamp: iso(at), parentId: null, type, data, ...extra });

export const events = (list: CopilotEvent[]) => `${list.map((e) => JSON.stringify(e)).join("\n")}\n`;

export const start = (at = 0, version: unknown = 1) =>
  event("session.start", at, { sessionId: SESSION, version, producer: "copilot-agent", copilotVersion: "1.0.114", startTime: iso(at), selectedModel: "stand-in", context: { cwd: "/work/orion", gitRoot: "/work/orion" } });
export const user = (content: string, at: number, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  event("user.message", at, { content, hasSubmittedTask: true, transformedContent: `<current_datetime>${iso(at)}</current_datetime>\n\n${content}`, messageId: uuid(), delivery: "idle", ...data }, extra);
export const assistant = (content: string, at: number, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  event("assistant.message", at, { messageId: uuid(), originatingMessageId: uuid(), model: "stand-in", content, toolRequests: [], interactionId: "i1", ...data }, extra);
export const system = (at: number) => event("system.message", at, { role: "system", content: `You are the GitHub Copilot CLI. <environment>OPENAI_API_KEY=${SECRET}</environment>`, metadata: {} });
export const hook = (hookType: string, at: number, output?: unknown) => [
  event("hook.start", at, { hookInvocationId: "h", hookType, input: { sessionId: SESSION, timestamp: 1, cwd: "/work/orion" } }),
  event("hook.end", at, { hookInvocationId: "h", hookType, success: true, ...(output ? { output } : {}) }),
];
/** Attache's sessionStart hook output: Copilot CLI keeps it only on the hook's end event. */
export const memoryHook = (at: number) => hook("sessionStart", at, { additionalContext: `<attache-memory>\n${MEMORY}\n</attache-memory>` });
export const turn = (at: number, id = "0") => [event("assistant.turn_start", at, { turnId: id, interactionId: "i1", agentMode: "interactive" }), event("session.usage_record", at, { usage: { model: "stand-in" } })];
export const turnEnd = (at: number, id = "0") => event("assistant.turn_end", at, { turnId: id });

/** A tool reading a secret-bearing file: the call, its execution, and its output. */
export function readTool(at: number): CopilotEvent[] {
  return [
    assistant("", at, { toolRequests: [{ toolCallId: "call_1", name: "view", arguments: { path: "/work/orion/.env" }, type: "function" }], reasoningText: `The key is ${SECRET}` }),
    event("tool.execution_start", at, { toolCallId: "call_1", toolName: "view", arguments: { path: "/work/orion/.env" } }),
    event("tool.execution_complete", at, { toolCallId: "call_1", success: true, result: { content: `# ${TOOL_OUTPUT}\nOPENAI_API_KEY=${SECRET}\n`, detailedContent: TOOL_OUTPUT } }),
    turnEnd(at),
  ];
}

/** A subagent the task tool starts: its events carry its agentId; its answer comes back as the tool's output. */
export function subagent(at: number): CopilotEvent[] {
  const side = { agentId: SUBAGENT };
  return [
    assistant("", at, { toolRequests: [{ toolCallId: "call_5", name: "task", arguments: { agent_type: "explore", prompt: `${SIDE} explore` }, type: "function" }] }),
    event("tool.execution_start", at, { toolCallId: "call_5", toolName: "task", arguments: { prompt: `${SIDE} explore` } }),
    event("subagent.started", at, { toolCallId: "call_5", agentName: "explore", agentDisplayName: "explorer" }, side),
    event("subagent.selected", at, { agentName: "explore", tools: ["view"] }, side),
    user(`${SIDE} please explore`, at, { source: `agent-${SESSION}` }, side),
    event("system.message", at, { role: "system", content: `You are an exploration agent. ${SIDE}` }, side),
    event("assistant.turn_start", at, { turnId: "0", parentToolCallId: "call_5" }, side),
    assistant(`${SIDE} answer`, at, {}, side),
    event("assistant.turn_end", at, { turnId: "0", parentToolCallId: "call_5" }, side),
    event("subagent.completed", at, { toolCallId: "call_5", agentName: "explore" }, side),
    event("tool.execution_complete", at, { toolCallId: "call_5", success: true, result: { content: `${SIDE} found it` } }),
    turnEnd(at),
  ];
}

/** /compact: Copilot CLI appends these and keeps every earlier event in the file. */
export function compaction(at: number): CopilotEvent[] {
  return [
    event("session.compaction_start", at, { compactionAttemptId: "c1", model: "stand-in" }),
    ...hook("preCompact", at),
    event("session.compaction_complete", at, { success: true, outcome: "applied", compactionAttemptId: "c1", summaryContent: `<overview>Orion cutover ${SIDE}</overview>`, messagesRemoved: 5 }),
  ];
}

/** A normal Copilot CLI session: start, Attache's memory hook, then two exchanges, the second reading a secret-bearing file. */
export function normal(): CopilotEvent[] {
  return [
    start(0),
    event("session.model_change", 0, { source: "startup", newModel: "stand-in" }),
    hook("sessionStart", 1)[0]!,
    event("instruction.update", 1, { content: `<system_reminder>${SIDE}</system_reminder>` }),
    user("Should the cutover wait for the audit?", 1),
    system(1),
    memoryHook(1)[1]!,
    ...turn(2),
    assistant("Yes: we decided to wait, because the audit closes Friday.", 2),
    turnEnd(2),
    ...hook("agentStop", 2),
    user("Check the env file", 3),
    ...turn(4),
    ...readTool(4),
    ...turn(5, "1"),
    assistant("The file sets an API key; I left it alone.", 5),
    turnEnd(5, "1"),
    ...hook("agentStop", 5),
  ];
}

export const shutdown = (at: number) => event("session.shutdown", at, { shutdownType: "routine", totalPremiumRequests: 0 });
export const resume = (at: number) => event("session.resume", at, { resumeTime: iso(at), eventCount: 20, selectedModel: "stand-in", context: { cwd: "/work/orion" } });
