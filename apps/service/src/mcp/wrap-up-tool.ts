import { z } from "zod";
import { WRAP_UP_POINTS_MAX, type WrapUpResult } from "@jarvis/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { BrainAccess } from "./brain.ts";
import { WRAP_UP_TOOL } from "./prompt-text.ts";
import { harnessSession, type ServerContext } from "./harness.ts";

function render(r: WrapUpResult): string {
  if (!r.stored) return r.reason;
  return `Stored ${r.points} point${r.points === 1 ? "" : "s"} as evidence in ${r.relPath} ("${r.title}", ${r.date}). They are evidence of this conversation, not curated memory.`;
}

/**
 * `wrap_up`: store the durable points of the current conversation as one
 * evidence document, labelled with the Harness that called it and the date.
 */
export function registerWrapUpTool(server: McpServer, brain: BrainAccess, context: ServerContext): void {
  server.registerTool(
    WRAP_UP_TOOL,
    {
      title: "Record a conversation's durable points",
      description: "Store the durable points of this conversation in the Brain as evidence, labelled with this Harness and today's date. Use it when the owner runs the wrap-up prompt. Pass an empty `points` list when nothing is durable: nothing is stored.",
      inputSchema: {
        title: z.string().trim().min(1).max(200).optional().describe("A short name for the conversation."),
        points: z.array(z.string().trim().min(1).max(2000)).max(WRAP_UP_POINTS_MAX).describe("The durable points, one self-contained sentence each. Empty when nothing is durable."),
      },
      outputSchema: { stored: z.boolean(), relPath: z.string().optional(), title: z.string().optional(), date: z.string().optional(), points: z.number().int().optional(), reason: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ title, points }): Promise<CallToolResult> => {
      try {
        const result = await brain.wrapUp({ harness: harnessSession(context.env, server.server.getClientVersion()).harness, points, ...(title ? { title } : {}) });
        return { content: [{ type: "text", text: render(result) }], structuredContent: { ...result } };
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: (e as Error).message }] };
      }
    },
  );
}
