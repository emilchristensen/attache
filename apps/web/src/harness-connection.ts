import type { HarnessCapabilities, HarnessCapture, HarnessFileChange, HarnessMemory, HarnessState } from "@attache/contracts";

/**
 * What a Harness Connection says before and after connecting (ADR 0006): each capability on its own, so MCP access
 * is never read as memory or session capture; every file connecting changes; and the Connection's state.
 */

const MEMORY: Record<HarnessMemory, string> = {
  none: "not given to new sessions",
  "runtime-fresh": "read fresh from your Brain when a session starts",
  "managed-file": "kept in a file the Harness always loads, rewritten when it changes",
};

const CAPTURE: Record<HarnessCapture, string> = {
  none: "none; use the wrap-up prompt to keep what a conversation decided",
  "with-final-event": "at compaction and when the session ends",
  "without-final-event": "at each turn, with no session end, so the newest in-flight turn can be missed",
};

export function capabilityLines(c: HarnessCapabilities): string[] {
  return [c.mcp ? "MCP access: search, read and save to your Brain" : "MCP access: none", `Memory: ${MEMORY[c.memory]}`, `Session capture: ${CAPTURE[c.capture]}`];
}

export function changeLine(c: HarnessFileChange): string {
  return `${c.change.charAt(0).toUpperCase()}${c.change.slice(1)} ${c.path}: ${c.purpose}${c.backup ? " (backed up first)" : ""}`;
}

export const HARNESS_STATE_TEXT: Record<HarnessState, string> = { current: "Up to date", stale: "Out of date", missing: "Missing", failed: "Could not be read" };
