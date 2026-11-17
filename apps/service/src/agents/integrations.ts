import { existsSync } from "node:fs";
import type { HookSpec } from "./hooks-config.ts";
import type { HookEvent } from "./spool.ts";
import { parseAntigravity, parseClaudeCode, parseCodex, type ParsedSession } from "./transcripts.ts";
import { locationsForHome } from "../platform/locations.ts";
import { HARNESS_FILES, harnessInstalls, type HarnessKind } from "../platform/harness-locations.ts";

/**
 * How a Harness runs Attache's hooks: where they live and in which shape,
 * which events to use, how memory reaches a new session, and how to read its
 * transcripts.
 */
export interface HarnessHooks {
  /** The hooks file, relative to the user's home. */
  configFile: string;
  /**
   * `event-groups`: `{ hooks: { Event: [{ matcher, hooks: [...] }] } }` (Claude Code, Codex).
   * `named`: `{ "<owner>": { Event: [{ type, command, timeout }] } }` (Antigravity).
   */
  format: "event-groups" | "named";
  /** Folder of always-loaded rule files; Attache writes the memory context there for Harnesses without a session-start hook. */
  rulesDir?: string;
  specs(command: (event: HookEvent) => string): HookSpec[];
  parseTranscript(raw: string): ParsedSession;
}

/**
 * A Harness Attache can connect: every one gets Attache's MCP server, and one
 * that runs hooks also gets the hooks that save its sessions.
 */
export interface AgentIntegration {
  kind: HarnessKind;
  label: string;
  /** Null for a Harness without hooks, which gets the MCP server only. */
  hooks: HarnessHooks | null;
  detect(home: string): boolean;
  /** Shown before the owner connects; explains what changes and anything the Harness asks them to do. */
  setupNote: string;
}

/** Whether a Harness is installed, judged from the home folder whose settings Attache edits (`platform/harness-locations.ts`). */
const installed = (kind: HarnessKind) => (home: string) => harnessInstalls(locationsForHome(home))[kind].presence.some((p) => existsSync(p));

const MCP_NOTE = "Attache's MCP server gives it search, read, save and audit tools and the save, audit and wrap-up prompts.";
const KEPT_NOTE = "Your other settings, hooks and servers are kept, and each file is backed up first.";

export const claudeCode: AgentIntegration = {
  kind: "claude-code",
  label: "Claude Code",
  hooks: {
    configFile: HARNESS_FILES["claude-code"].hooksFile!,
    format: "event-groups",
    // SessionEnd has a short shared budget (about 1.5 s), so it gets the tightest timeout.
    specs: (command) => [
      { event: "SessionStart", matcher: "", command: command("session-start"), timeout: 10 },
      { event: "PreCompact", matcher: "", command: command("pre-compact"), timeout: 10 },
      { event: "SessionEnd", matcher: "", command: command("session-end"), timeout: 5 },
    ],
    parseTranscript: parseClaudeCode,
  },
  detect: installed("claude-code"),
  setupNote: `Adds Attache's MCP server to ~/.claude.json and three hooks to ~/.claude/settings.json: SessionStart gives each new session your Attache memory, PreCompact and SessionEnd save the conversation. ${MCP_NOTE} ${KEPT_NOTE}`,
};

export const codex: AgentIntegration = {
  kind: "codex",
  label: "Codex",
  hooks: {
    configFile: HARNESS_FILES.codex.hooksFile!,
    format: "event-groups",
    // SessionStart also fires after a compaction, so memory comes back too. Codex caps SessionEnd at 3 s.
    specs: (command) => [
      { event: "SessionStart", matcher: "", command: command("session-start"), timeout: 10, options: { additionalContextLimit: 6000 } },
      { event: "PreCompact", matcher: "", command: command("pre-compact"), timeout: 10 },
      { event: "SessionEnd", matcher: "", command: command("session-end"), timeout: 3 },
    ],
    parseTranscript: parseCodex,
  },
  detect: installed("codex"),
  setupNote: `Adds Attache's MCP server to ~/.codex/config.toml and three hooks to ~/.codex/hooks.json: SessionStart gives each new session your Attache memory, PreCompact and SessionEnd save the conversation. ${MCP_NOTE} ${KEPT_NOTE} Codex runs new hooks only after you approve them: the next time Codex starts, choose Review hooks and trust the three Attache hooks. Codex remembers that trust by position, so after you disconnect it may ask you to review hooks that came after Attache's again.`,
};

export const antigravity: AgentIntegration = {
  kind: "antigravity",
  label: "Antigravity",
  hooks: {
    configFile: HARNESS_FILES.antigravity.hooksFile!,
    format: "named",
    rulesDir: HARNESS_FILES.antigravity.rulesDir!,
    // Antigravity has no session-end or compaction event; Stop fires after every turn.
    specs: (command) => [{ event: "Stop", command: command("turn-end"), timeout: 10 }],
    parseTranscript: parseAntigravity,
  },
  detect: installed("antigravity"),
  setupNote: `Adds Attache's MCP server to ~/.gemini/config/mcp_config.json, an Attache entry to ~/.gemini/config/hooks.json that saves the conversation after each turn, and an always-on rule ~/.gemini/config/rules/attache-memory.md that gives each session your Attache memory. ${MCP_NOTE} ${KEPT_NOTE} Applies to the Antigravity app and the agy CLI.`,
};

export const claudeDesktop: AgentIntegration = {
  kind: "claude-desktop",
  label: "Claude Desktop",
  // Its Code tab runs Claude Code, whose hooks already save those sessions; the Chat tab runs none.
  hooks: null,
  detect: installed("claude-desktop"),
  setupNote: `Adds Attache's MCP server to Claude Desktop's claude_desktop_config.json. ${MCP_NOTE} Use the wrap-up prompt to keep what a chat decided. Your other settings and servers are kept, and the file is backed up first. Restart Claude Desktop to load the server.`,
};

export const AGENT_INTEGRATIONS: AgentIntegration[] = [claudeCode, codex, antigravity, claudeDesktop];
export type AgentKind = AgentIntegration["kind"];
/** The Harnesses whose sessions Attache saves through hooks. */
export const HOOK_AGENT_KINDS = AGENT_INTEGRATIONS.filter((a) => a.hooks).map((a) => a.kind);
export const integrationFor = (kind: string) => AGENT_INTEGRATIONS.find((a) => a.kind === kind) ?? null;

/** How the owner knows a Harness: its integration's label, or the name it gave Attache. */
export const harnessLabel = (kind: string): string => integrationFor(kind)?.label ?? kind;
