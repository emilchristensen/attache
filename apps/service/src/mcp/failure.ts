import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** A tool call that failed, with the service's message for the agent to act on. */
export function failure(e: unknown): CallToolResult {
  return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
}
