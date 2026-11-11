import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { auditPrompt, savePrompt, wrapUpPrompt } from "./prompt-text.ts";

const REQUEST_MAX = 2_000;

function asUserMessage(text: string): GetPromptResult {
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

/** The `save`, `audit` and `wrap-up` prompts, which the owner invokes from their Harness. */
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
  server.registerPrompt(
    "wrap-up",
    {
      title: "Wrap up this conversation",
      description: "Record the durable points of this conversation in the Brain as evidence, for conversations Jarvis cannot capture itself.",
    },
    () => asUserMessage(wrapUpPrompt()),
  );
}
