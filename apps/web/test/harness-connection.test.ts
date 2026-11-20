import { describe, expect, it } from "vitest";
import { uninstallProblem } from "@attache/contracts";
import { capabilityLines, changeLine, HARNESS_STATE_TEXT } from "../src/harness-connection.ts";

// What a Harness Connection says before and after connecting (ADR 0006): each capability on its own, every file it
// will change, its state, and what a disconnect left behind.

describe("capabilityLines", () => {
  it("never reads MCP access as memory or session capture", () => {
    expect(capabilityLines({ mcp: true, memory: "none", capture: "none" })).toEqual([
      "MCP access: search, read and save to your Brain",
      "Memory: not given to new sessions",
      "Session capture: none; use the wrap-up prompt to keep what a conversation decided",
    ]);
  });
  it("states that the newest in-flight turn can be missed without a final event", () => {
    expect(capabilityLines({ mcp: true, memory: "managed-file", capture: "without-final-event" })).toEqual([
      "MCP access: search, read and save to your Brain",
      "Memory: kept in a file the Harness always loads, rewritten when it changes",
      "Session capture: at each turn, with no session end, so the newest in-flight turn can be missed",
    ]);
  });
  it("describes runtime-fresh memory and capture reconciled at session end", () => {
    expect(capabilityLines({ mcp: true, memory: "runtime-fresh", capture: "with-final-event" }).slice(1)).toEqual(["Memory: read fresh from your Brain when a session starts", "Session capture: at compaction and when the session ends"]);
  });
});

describe("changeLine", () => {
  it("says what changes in a file and whether it is backed up first", () => {
    expect(changeLine({ path: "/h/.claude.json", change: "update", backup: true, purpose: "Attache's MCP server" })).toBe("Update /h/.claude.json: Attache's MCP server (backed up first)");
    expect(changeLine({ path: "/h/rules/attache-memory.md", change: "create", backup: false, purpose: "your Attache memory" })).toBe("Create /h/rules/attache-memory.md: your Attache memory");
  });
});

describe("HARNESS_STATE_TEXT", () => {
  it("names every state", () => {
    expect(HARNESS_STATE_TEXT).toEqual({ current: "Up to date", stale: "Out of date", missing: "Missing", failed: "Could not be read" });
  });
});

describe("uninstallProblem", () => {
  it("is null when everything was removed, and names what remains otherwise", () => {
    expect(uninstallProblem({ removed: [], failures: [] })).toBeNull();
    expect(uninstallProblem({ removed: [], failures: ["/h/.claude/settings.json is not valid JSON; Attache will not change it."] })).toBe("Disconnected, but some of Attache's entries remain: /h/.claude/settings.json is not valid JSON; Attache will not change it.");
  });
});
