import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MemorySaveInput, type MemorySaveProposalResult, type MemorySaveResult } from "@jarvis/contracts";
import { plural } from "../core/wording.ts";
import type { BrainAccess } from "./brain.ts";
import { askOwner, confirmationMessage } from "./confirmation.ts";
import { harnessSession, saveOrigin, type ServerContext } from "./harness.ts";

const SavedShape = z.object({ action: z.enum(["created", "updated"]), path: z.string(), title: z.string(), facts: z.number().int(), events: z.number().int() });
const ProposedShape = z.object({ id: z.string(), target: z.string() });

const DESCRIPTION = [
  "Save facts and events to the owner's Brain. Jarvis first asks the owner to confirm inside the Harness, listing every item; nothing is written unless they accept. If the owner switched on auto-accept for this Harness, the save is written without asking.",
  "Facts are current state: one value per subject, replacing the old value, which moves to the note's History. Events are things that happened, appended to History.",
  "Create a note only after `search` found none of the same type and title; otherwise update it by its path. Every item is checked before anything is written, so one invalid item rejects the whole save.",
  "The owner's identity record (memory/self.md) cannot be changed here. A Harness that cannot ask the owner gets each item stored as a Proposal for review in the Jarvis Dashboard.",
].join(" ");

type Reply = { outcome: "saved"; autoAccepted: boolean; saved: z.infer<typeof SavedShape>[] } | { outcome: "declined" } | { outcome: "proposed"; proposals: z.infer<typeof ProposedShape>[] };

/** The save tool: check, ask the owner, then write as the owner, or store Proposals when the Harness cannot ask. */
export function registerSaveTool(server: McpServer, brain: BrainAccess, context: ServerContext): void {
  server.registerTool(
    "save",
    {
      title: "Save to the Brain",
      description: DESCRIPTION,
      inputSchema: { items: MemorySaveInput.shape.items.describe("The changes to save, one item per note: create a new note with its facts, or update an existing note by path.") },
      outputSchema: {
        outcome: z.enum(["saved", "declined", "proposed"]),
        autoAccepted: z.boolean().optional().describe("True when the save was written without asking, because the owner switched on auto-accept for this Harness."),
        saved: z.array(SavedShape).optional(),
        proposals: z.array(ProposedShape).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ items }, extra) => {
      try {
        const caller = harnessSession(context.env, server.server.getClientVersion());
        const origin = saveOrigin(caller, context.cwd);
        const check = await brain.checkSave({ origin, items });
        const harness = caller.harness.label;
        if (check.autoAccept) return saved(await brain.save({ origin, items, autoAccept: true }), harness);
        const answer = await askOwner(server.server, confirmationMessage(harness, items, check), extra.requestId);
        if (answer === "unsupported") return proposed(await brain.propose({ origin, items, reason: `${harness} asked to save this but cannot ask you to confirm, so it waits for your review.` }));
        if (answer !== "accept") return declined(answer);
        return saved(await brain.save({ origin, items, confirmed: true }), null);
      } catch (e) {
        return { isError: true, content: [{ type: "text", text: `Nothing was saved. ${(e as Error).message}` }] };
      }
    },
  );
}

function reply(text: string, data: Reply): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: data };
}

/** `autoAcceptedFor` names the Harness when auto-accept wrote the save without asking; null when the owner confirmed it. */
function saved(result: MemorySaveResult, autoAcceptedFor: string | null): CallToolResult {
  const list = result.saved.map((s) => ({ action: s.action, path: s.relPath, title: s.title, facts: s.facts, events: s.events }));
  const lines = list.map((s) => `- ${s.action} ${s.path} (${s.title}): ${plural(s.facts, "fact")}, ${plural(s.events, "event")}`);
  const how = autoAcceptedFor ? `The owner switched on auto-accept for ${autoAcceptedFor} on this Machine, so the save was written without asking.` : "The owner confirmed the save.";
  return reply(`${how} Written to the Brain:\n${lines.join("\n")}`, { outcome: "saved", autoAccepted: autoAcceptedFor !== null, saved: list });
}

function declined(answer: "decline" | "cancel"): CallToolResult {
  const why = answer === "decline" ? "The owner declined the save" : "The owner closed the confirmation without accepting";
  return reply(`${why}, so nothing was written to the Brain. Do not save it again unless the owner asks you to.`, { outcome: "declined" });
}

function proposed(result: MemorySaveProposalResult): CallToolResult {
  const list = result.proposals.map((p) => ({ id: p.id, target: p.target }));
  const lines = list.map((p) => `- ${p.target}`);
  return reply(
    `This Harness cannot ask the owner to confirm a save, so each item is stored as a Proposal and awaits the owner's review in the Jarvis Dashboard. Nothing is in the Brain until they apply it.\n${lines.join("\n")}`,
    { outcome: "proposed", proposals: list },
  );
}
