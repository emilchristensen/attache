import { WRAP_UP_POINTS_MAX } from "@jarvis/contracts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WRAP_UP_TOOL } from "../wrap-up-tool.ts";

/**
 * What the agent is asked to do when the owner runs the wrap-up prompt. It is
 * meant for conversations Jarvis cannot capture itself, such as Claude
 * Desktop's Chat tab: the agent distils them, and `wrap_up` stores the result
 * as evidence.
 */
export const WRAP_UP_TEXT = [
  "Wrap up this conversation for Jarvis.",
  "",
  "Read back over the conversation so far and pick out its durable points: what will still matter in a week or a month.",
  "That means decisions and why they were made, facts about people, projects and the owner's work, commitments with who owns them and by when, and preferences the owner stated.",
  "Leave out small talk, the step-by-step of the work itself, and anything secret such as passwords, tokens or keys.",
  "",
  "Write each point as one sentence that makes sense without the conversation: name the people and projects, and write dates as YYYY-MM-DD.",
  `Keep to the points that matter, at most ${WRAP_UP_POINTS_MAX}.`,
  "",
  `Then call the \`${WRAP_UP_TOOL}\` tool once, with a short \`title\` for the conversation and the points.`,
  "Jarvis stores them in the Brain as evidence of this conversation, not as curated memory: none of them becomes a current fact unless it is saved to a note later.",
  "",
  `If the conversation holds nothing durable, call \`${WRAP_UP_TOOL}\` with an empty \`points\` list: Jarvis stores nothing.`,
  "",
  "Finish by telling the owner in a line or two what was stored and where, or that there was nothing durable to store.",
].join("\n");

export function registerWrapUpPrompt(server: McpServer): void {
  server.registerPrompt(
    "wrap-up",
    {
      title: "Wrap up this conversation",
      description: "Record the durable points of this conversation in the Brain as evidence, for conversations Jarvis cannot capture itself.",
    },
    () => ({ messages: [{ role: "user", content: { type: "text", text: WRAP_UP_TEXT } }] }),
  );
}
