import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ErrorCode, McpError, type RequestId } from "@modelcontextprotocol/sdk/types.js";
import type { MemorySaveCheckResult, MemorySaveItem } from "@attache/contracts";

/** How long the owner has to answer before the save is given up. */
export const CONFIRMATION_TIMEOUT_MS = 10 * 60_000;

/** Prose notes longer than this are shortened in the confirmation; facts and events are always shown whole. */
const NOTES_PREVIEW = 400;

/** The owner's answer, or that the Harness cannot ask. */
export type OwnerAnswer = "accept" | "decline" | "cancel" | "unsupported";

/** An answer that never came: the Harness failed to show the request, or the owner left it open too long. */
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

/**
 * Ask the owner inside the Harness, through an MCP confirmation request
 * (elicitation) with no fields to fill: accepting is the confirmation.
 * A Harness that does not offer the request answers "unsupported".
 */
export async function askOwner(server: Server, message: string, relatedRequestId: RequestId): Promise<OwnerAnswer> {
  if (!server.getClientCapabilities()?.elicitation?.form) return "unsupported";
  try {
    const result = await server.elicitInput({ mode: "form", message, requestedSchema: { type: "object", properties: {} } }, { relatedRequestId, timeout: CONFIRMATION_TIMEOUT_MS });
    return result.action;
  } catch (e) {
    if (e instanceof McpError && e.code === ErrorCode.MethodNotFound) return "unsupported";
    if (e instanceof McpError && e.code === ErrorCode.RequestTimeout) throw new ConfirmationError(`The owner did not answer the confirmation within ${CONFIRMATION_TIMEOUT_MS / 60_000} minutes, so nothing was written. Ask them, then save again.`);
    throw new ConfirmationError(`The Harness could not show the confirmation (${(e as Error).message}), so nothing was written.`);
  }
}
