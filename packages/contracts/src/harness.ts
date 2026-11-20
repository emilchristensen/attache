/**
 * API contract: what a Harness Connection can do and what connecting it changes (ADR 0006).
 *
 * Each capability is reported on its own. MCP access is the baseline every connected Harness gets; memory and
 * session capture are separate answers, and neither follows from the other or from MCP access.
 */

/**
 * How Attache memory reaches a Harness session.
 * - `none`: it does not; the agent can still search the Brain through MCP.
 * - `runtime-fresh`: the Harness reads the Brain's memory when a session starts or at a prompt boundary.
 * - `managed-file`: Attache keeps a file the Harness always loads, rewritten when the memory changes.
 */
export const HARNESS_MEMORY = ["none", "runtime-fresh", "managed-file"] as const;
export type HarnessMemory = (typeof HARNESS_MEMORY)[number];

/**
 * How Attache saves a Harness's sessions.
 * - `none`: it does not; the wrap-up prompt is the way to keep what a conversation decided.
 * - `with-final-event`: at turn, stop or compaction boundaries, reconciled when the session ends.
 * - `without-final-event`: at the boundaries the Harness offers but with no session end, so the newest in-flight
 *   turn can be missed; the Connection's notes say so.
 */
export const HARNESS_CAPTURE = ["none", "with-final-event", "without-final-event"] as const;
export type HarnessCapture = (typeof HARNESS_CAPTURE)[number];

/** What one Harness integration does once connected, each part independent of the others. */
export interface HarnessCapabilities {
  /** Attache's MCP server is registered in the Harness: search, read, save and audit. */
  mcp: boolean;
  memory: HarnessMemory;
  capture: HarnessCapture;
}

/**
 * A Harness Connection's state, judged from the files Attache owns in it.
 * - `current`: everything is there and matches what this version writes.
 * - `stale`: Attache's entries are there but out of date; refreshing fixes them.
 * - `missing`: none or only part of Attache's entries are there.
 * - `failed`: a file could not be read or parsed, so the state is unknown.
 */
export const HARNESS_STATES = ["current", "stale", "missing", "failed"] as const;
export type HarnessState = (typeof HARNESS_STATES)[number];

/** One file a Harness connection creates, updates or removes. */
export interface HarnessFileChange {
  /** Absolute path of the file. */
  path: string;
  change: "create" | "update" | "remove";
  /** Whether the file exists now, so Attache backs it up before the change. */
  backup: boolean;
  /** What Attache keeps in the file, in the owner's words. */
  purpose: string;
}

/** The changes connecting (or refreshing) would make, worked out before anything is written. */
export interface HarnessPreview {
  changes: HarnessFileChange[];
  /** Whether a running Harness must be restarted before the changes take effect. */
  restartRequired: boolean;
}

/** What applying or refreshing changed. */
export interface HarnessApplyResult {
  changes: HarnessFileChange[];
  /** Backups of the existing files that changed. */
  backups: string[];
  restartRequired: boolean;
}

/** A Harness Connection's state with the reason, for the Dashboard and `attache agent-hooks status`. */
export interface HarnessStatusReport {
  state: HarnessState;
  /** What is there or what is wrong, and what to do next. */
  message: string;
  /** The files Attache owns entries in. */
  files: string[];
}

/** What disconnecting removed, and what it could not. */
export interface HarnessUninstallResult {
  removed: HarnessFileChange[];
  /** One message per part that could not be removed, each naming its file; empty when everything went. */
  failures: string[];
}
