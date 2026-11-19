import type { ActionView } from "@attache/contracts";

/**
 * Reading the loosely typed parts of a Draft (`target`, `payload`, `context`, `receipt`): what the service stored there
 * is JSON of no fixed shape, so every read goes through these.
 */

/** A string with something in it, trimmed; null for anything else. */
export const textOf = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** An object's fields; an empty record for anything else. */
export const recordOf = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** The id of the Inbox item a Draft answers, from its context; null when it answers none. */
export const draftItemId = (d: Pick<ActionView, "context">): string | null => textOf(recordOf(recordOf(d.context).item).id);
