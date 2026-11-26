/**
 * The Brain format: the version of how replicated files (notes, evidence, Inbox
 * items, Machine records, Preferences) are laid out. A Machine records the
 * newest one it can read in its Machine record, and the format rises only once
 * every Machine heard from in the last 30 days can read the new one (ADR 0008).
 */
export const READABLE_BRAIN_FORMAT = 1;
