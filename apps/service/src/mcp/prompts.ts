import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { auditPrompt, savePrompt } from "./prompt-text.ts";

const REQUEST_MAX = 2_000;

function asUserMessage(text: string): GetPromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

/** The `save` and `audit` prompts, which the owner invokes from their Harness. */
export function registerPrompts(server: McpServer): void {
  server.registerPrompt(
    "save",
    {
      title: "Save to Jarvis",
      description: "Distill what matters from the last turn into the owner's Brain, through the save tool.",
      argsSchema: { focus: z.string().max(REQUEST_MAX).optional().describe("What to focus on, if not everything that matters.") },
    },
    ({ focus }) => asUserMessage(savePrompt(focus)),
  );
  server.registerPrompt(
    "audit",
    {
      title: "Audit Jarvis memory",
      description: "Find facts in the owner's Brain that have quietly stopped being true, and fix the ones the owner agrees to.",
      argsSchema: { topic: z.string().max(REQUEST_MAX).optional().describe("A topic to limit the audit to.") },
    },
    ({ topic }) => asUserMessage(auditPrompt(topic)),
  );
}
