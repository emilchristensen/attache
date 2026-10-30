/** Pure helpers shared by the claude.ai connector session and runner. */

export interface PlannedCall {
  /** Caller-chosen id, unique within one run. */
  id: string;
  /** Tool name as the connector publishes it, e.g. "slack_read_channel". */
  tool: string;
  args: Record<string, unknown>;
}

export type CallOutcome = { status: "ok"; text: string } | { status: "tool_error"; text: string };

export interface ServerInfo {
  name: string;
  status: string;
  source: string | null;
}

/** Claude Code's tool name for a connector tool: "claude.ai Google Calendar" + "list_events" → "mcp__claude_ai_Google_Calendar__list_events". */
export function serverPrefix(server: string): string {
  return `mcp__${server.replace(/[^A-Za-z0-9_-]/g, "_")}`;
}

export function fullToolName(server: string, tool: string): string {
  return `${serverPrefix(server)}__${tool}`;
}

/** Structural equality for JSON values; object key order is irrelevant. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

/**
 * Permission rules in the user's own Claude Code settings that would approve a
 * connector tool without asking Jarvis. Such a rule would let a call run
 * without Jarvis checking its arguments, so a session refuses to start.
 */
export function preApprovingRules(allowRules: unknown, server: string): string[] {
  if (!Array.isArray(allowRules)) return [];
  const prefix = serverPrefix(server);
  return allowRules.filter((r): r is string => typeof r === "string").filter((r) => r === prefix || r.startsWith(`${prefix}__`) || r === "mcp__*" || r === "*");
}
