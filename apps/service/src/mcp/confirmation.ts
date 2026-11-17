import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, McpError, type RequestId } from "@modelcontextprotocol/sdk/types.js";
import type { MemorySaveCheckResult, MemorySaveItem } from "@attache/contracts";
import { systemClock, type Clock } from "../replication/clock.ts";

/** How long the owner has to answer before Attache takes it that nobody can, and stores Proposals instead. */
export const CONFIRMATION_TIMEOUT_MS = 2 * 60_000;

/**
 * A decline or close that comes back sooner than this was not a person's:
 * a Harness in print mode answers in a few milliseconds without showing anyone.
 */
export const FASTEST_PERSON_MS = 1_000;

/** Prose notes longer than this are shortened in the confirmation; facts and events are always shown whole. */
const NOTES_PREVIEW = 400;

/**
 * Why the save could not be put to the owner: the Harness does not offer the
 * request (`unsupported`), it answered faster than a person could (`instant`),
 * or nobody answered within the time limit on this connection (`unanswered`).
 */
export type CannotAsk = "unsupported" | "instant" | "unanswered";

/** The owner's answer, or why the Harness could not ask them. */
export type OwnerAnswer = { asked: true; action: "accept" | "decline" | "cancel" } | { asked: false; why: CannotAsk };

/** The Harness failed to show the request for another reason. */
export class ConfirmationError extends Error {}

/**
 * What the owner reads before deciding: every item with each fact, event,
 * note and tag it writes, numbered in the order they are written.
 */
export function confirmationMessage(harness: string, items: readonly MemorySaveItem[], check: MemorySaveCheckResult): string {
  const count = items.length === 1 ? "1 change" : `${items.length} changes`;
  const blocks = items.map((item, i) => [`${i + 1}. ${heading(item, check.items[i])}`, ...details(item).map((d) => `   - ${d}`)].join("\n"));
  return [`${harness} asks to save ${count} to your Attache Brain:`, "", ...blocks, "", "Accept to write them as you. Decline to write nothing."].join("\n");
}

function heading(item: MemorySaveItem, checked: MemorySaveCheckResult["items"][number] | undefined): string {
  if (item.action === "create") return `New ${item.type} "${item.title}"`;
  return `Update "${checked?.title ?? item.path}" (${checked?.relPath ?? item.path})`;
}

function details(item: MemorySaveItem): string[] {
  const facts = (item.facts ?? []).map((f) => `${f.subject}: ${f.value}${f.review ? ` (review after ${f.review})` : ""}${"reason" in f ? ` (why: ${f.reason})` : ""}`);
  const events = (item.events ?? []).map((e) => `Event: ${e}`);
  if (item.action === "update") return [...facts, ...events];
  const notes = item.notes?.trim();
  return [
    ...facts,
    ...events,
    ...(notes ? [`Notes: ${notes.length > NOTES_PREVIEW ? `${notes.slice(0, NOTES_PREVIEW)}… (${notes.length - NOTES_PREVIEW} more characters)` : notes}`] : []),
    ...(item.tags?.length ? [`Tags: ${item.tags.join(", ")}`] : []),
  ];
}

/** Asks the owner over one MCP connection, and remembers when nobody answered there. */
export interface OwnerConfirmation {
  ask(message: string, relatedRequestId: RequestId): Promise<OwnerAnswer>;
}

const cannotAsk = (why: CannotAsk): OwnerAnswer => ({ asked: false, why });

/**
 * Ask the owner inside the Harness, through an MCP confirmation request
 * (elicitation) with no fields to fill: accepting is the confirmation.
 * After one request goes unanswered, later saves on the same connection do
 * not ask again, so a Harness that never shows the request costs one wait.
 * `clock` times the wait and the answer; the system clock outside tests.
 */
export function ownerConfirmation(server: Server, clock: Clock = systemClock): OwnerConfirmation {
  let unanswered = false;
  return {
    async ask(message, relatedRequestId) {
      if (!server.getClientCapabilities()?.elicitation?.form) return cannotAsk("unsupported");
      if (unanswered) return cannotAsk("unanswered");
      const waited = new AbortController();
      const timer = clock.setTimeout(() => waited.abort(), CONFIRMATION_TIMEOUT_MS);
      const sent = clock.now().getTime();
      try {
        // The SDK's own timeout is a backstop at the same limit: its default (one minute) would cut the wait short.
        const result = await server.elicitInput({ mode: "form", message, requestedSchema: { type: "object", properties: {} } }, { relatedRequestId, signal: waited.signal, timeout: CONFIRMATION_TIMEOUT_MS });
        if (result.action !== "accept" && clock.now().getTime() - sent < FASTEST_PERSON_MS) return cannotAsk("instant");
        return { asked: true, action: result.action };
      } catch (e) {
        if (e instanceof McpError && e.code === ErrorCode.MethodNotFound) return cannotAsk("unsupported");
        if (waited.signal.aborted || (e instanceof McpError && e.code === ErrorCode.RequestTimeout)) {
          unanswered = true;
          return cannotAsk("unanswered");
        }
        throw new ConfirmationError(`The Harness could not show the confirmation (${(e as Error).message}), so nothing was written.`);
      } finally {
        clock.clearTimeout(timer);
      }
    },
  };
}
