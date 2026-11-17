import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { MemorySaveInput, plural, type MemorySaveProposalResult, type MemorySaveResult } from "@attache/contracts";
import type { BrainAccess } from "./brain.ts";
import { CONFIRMATION_TIMEOUT_MS, confirmationMessage, ownerConfirmation, type CannotAsk } from "./confirmation.ts";
import { harnessSession, saveOrigin, type ServerContext } from "./harness.ts";
import type { Clock } from "../replication/clock.ts";

const SavedShape = z.object({ action: z.enum(["created", "updated"]), path: z.string(), title: z.string(), facts: z.number().int(), events: z.number().int() });
const ProposedShape = z.object({ id: z.string(), target: z.string() });

const DESCRIPTION = [
  "Save facts and events to the owner's Brain. A connected Harness has auto-accept on unless the owner switched it off, so the save is written without asking and the owner can see and revert it in the Attache Dashboard. With auto-accept off, Attache first asks the owner to confirm inside the Harness, listing every item; nothing is written unless they accept.",
  "Facts are current state: one value per subject, replacing the old value, which moves to the note's History. Events are things that happened, appended to History.",
  "Create a note only after `search` found none of the same type and title; otherwise update it by its path. Every item is checked before anything is written, so one invalid item rejects the whole save.",
  "The owner's identity record (memory/self.md) cannot be changed here. A Harness that cannot ask the owner gets each item stored as a Proposal for review in the Attache Dashboard.",
].join(" ");

type Reply =
  | { outcome: "saved"; autoAccepted: boolean; message: string; saved: z.infer<typeof SavedShape>[] }
  | { outcome: "declined"; message: string }
  | { outcome: "proposed"; cannotAsk: CannotAsk; message: string; proposals: z.infer<typeof ProposedShape>[] };

const TIMEOUT_MINUTES = CONFIRMATION_TIMEOUT_MS / 60_000;

/** Why the owner could not be asked, as each Proposal's reason tells the owner and the reply tells the agent. */
const CANNOT_ASK: Record<CannotAsk, { reason: (harness: string) => string; reply: string }> = {
  unsupported: {
    reason: (harness) => `${harness} asked to save this but cannot ask you to confirm, so it waits for your review.`,
    reply: "This Harness cannot ask the owner to confirm a save.",
  },
  instant: {
    reason: (harness) => `${harness} asked to save this, but it answered the confirmation faster than a person could, so nobody saw it. It waits for your review.`,
    reply: "This Harness answered the confirmation faster than a person could, so the owner never saw it.",
  },
  unanswered: {
    reason: (harness) => `${harness} asked to save this, but nobody answered the confirmation within ${TIMEOUT_MINUTES} minutes, so it waits for your review.`,
    reply: `Nobody answered Attache's confirmation on this connection within ${TIMEOUT_MINUTES} minutes, so Attache does not ask here again.`,
  },
};

/**
 * The save tool: check, ask the owner, then write as the owner, or store
 * Proposals when the owner could not be asked. `clock` times the
 * confirmation; the system clock outside tests.
 */
export function registerSaveTool(server: McpServer, brain: BrainAccess, context: ServerContext, clock?: Clock): void {
  const owner = ownerConfirmation(server.server, clock);
  server.registerTool(
    "save",
    {
      title: "Save to the Brain",
      description: DESCRIPTION,
      inputSchema: { items: MemorySaveInput.shape.items.describe("The changes to save, one item per note: create a new note with its facts, or update an existing note by path.") },
      outputSchema: {
        outcome: z.enum(["saved", "declined", "proposed"]),
        message: z.string().optional().describe("What happened to the save, and what to do next. Some Harnesses show the agent only these fields, not the text."),
        cannotAsk: z.enum(["unsupported", "instant", "unanswered"]).optional().describe("Why the owner could not be asked, when the save became Proposals: the Harness does not offer confirmation, answered faster than a person could, or nobody answered in time."),
        autoAccepted: z.boolean().optional().describe("True when the save was written without asking, because auto-accept is on for this Harness."),
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
        const answer = await owner.ask(confirmationMessage(harness, items, check), extra.requestId);
        if (!answer.asked) return proposed(await brain.propose({ origin, items, reason: CANNOT_ASK[answer.why].reason(harness) }), answer.why);
        if (answer.action !== "accept") return declined(answer.action);
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
  const how = autoAcceptedFor ? `Auto-accept is on for ${autoAcceptedFor} on this Machine, so the save was written without asking; the owner can revert it in the Attache Dashboard.` : "The owner confirmed the save.";
  const message = `${how} Written to ${plural(list.length, "note")} in the Brain.`;
  return reply(`${how} Written to the Brain:\n${lines.join("\n")}`, { outcome: "saved", autoAccepted: autoAcceptedFor !== null, message, saved: list });
}

function declined(answer: "decline" | "cancel"): CallToolResult {
  const why = answer === "decline" ? "The owner declined the save" : "The owner closed the confirmation without accepting";
  const message = `${why}, so nothing was written to the Brain. Do not save it again unless the owner asks you to.`;
  return reply(message, { outcome: "declined", message });
}

function proposed(result: MemorySaveProposalResult, why: CannotAsk): CallToolResult {
  const list = result.proposals.map((p) => ({ id: p.id, target: p.target }));
  const lines = list.map((p) => `- ${p.target}`);
  const message = `${CANNOT_ASK[why].reply} So the save waits in the Attache Dashboard: each item is stored as a Proposal and awaits the owner's review. Nothing is in the Brain until they apply it, and saving it again would only add a second Proposal.`;
  return reply(`${message}\n${lines.join("\n")}`, { outcome: "proposed", cannotAsk: why, message, proposals: list });
}
