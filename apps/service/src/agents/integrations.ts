import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HookSpec } from "./hooks-config.ts";
import type { SkillPackaging } from "./skills.ts";
import type { HookEvent } from "./spool.ts";
import { parseAntigravity, parseClaudeCode, parseCodex, type ParsedSession } from "./transcripts.ts";

/**
 * A coding agent Jarvis can hook into: where its hooks live and in which
 * shape, which events to use, how memory reaches a new session, and how to
 * read its transcripts.
 */
export interface AgentIntegration {
  kind: "claude-code" | "codex" | "antigravity";
  label: string;
  /** The hooks file, relative to the user's home. */
  configFile: string;
  /**
   * `event-groups`: `{ hooks: { Event: [{ matcher, hooks: [...] }] } }` (Claude Code, Codex).
   * `named`: `{ "<owner>": { Event: [{ type, command, timeout }] } }` (Antigravity).
   */
  format: "event-groups" | "named";
  /** Folder of always-loaded rule files; Jarvis writes the memory context there for agents without a session-start hook. */
  rulesDir?: string;
  detect(home: string): boolean;
  hookSpecs(command: (event: HookEvent) => string): HookSpec[];
  parseTranscript(raw: string): ParsedSession;
  /** Where the user-invoked save and audit skills go, and how they are kept away from the model. */
  skills?: SkillPackaging;
  /** How the user types a skill in this agent, e.g. `/jarvis-save`. */
  skillInvocation(name: string): string;
  /** Shown before the user connects; explains what changes and anything the agent asks them to do. The skills are described separately. */
  setupNote: string;
}

const anyExists = (paths: string[]) => paths.some((p) => existsSync(p));

export const claudeCode: AgentIntegration = {
  kind: "claude-code",
  label: "Claude Code",
  configFile: ".claude/settings.json",
  format: "event-groups",
  detect: (home) => anyExists([join(home, ".claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude", join(home, ".local/bin/claude"), join(home, ".claude/local/claude")]),
  // SessionEnd has a short shared budget (about 1.5 s), so it gets the tightest timeout.
  hookSpecs: (command) => [
    { event: "SessionStart", matcher: "", command: command("session-start"), timeout: 10 },
    { event: "PreCompact", matcher: "", command: command("pre-compact"), timeout: 10 },
    { event: "SessionEnd", matcher: "", command: command("session-end"), timeout: 5 },
  ],
  parseTranscript: parseClaudeCode,
  // Claude Code reads only ~/.claude/skills.
  skills: { dir: ".claude/skills" },
  skillInvocation: (name) => `/${name}`,
  setupNote: "Adds three hooks to ~/.claude/settings.json: SessionStart gives each new session your Jarvis memory, PreCompact and SessionEnd save the conversation. Your other settings and hooks are kept, and the file is backed up first.",
};

export const codex: AgentIntegration = {
  kind: "codex",
  label: "Codex",
  configFile: ".codex/hooks.json",
  format: "event-groups",
  detect: (home) => anyExists([join(home, ".codex"), "/opt/homebrew/bin/codex", "/usr/local/bin/codex", join(home, ".local/bin/codex")]),
  // SessionStart also fires after a compaction, so memory comes back too. Codex caps SessionEnd at 3 s.
  hookSpecs: (command) => [
    { event: "SessionStart", matcher: "", command: command("session-start"), timeout: 10, options: { additionalContextLimit: 6000 } },
    { event: "PreCompact", matcher: "", command: command("pre-compact"), timeout: 10 },
    { event: "SessionEnd", matcher: "", command: command("session-end"), timeout: 3 },
  ],
  parseTranscript: parseCodex,
  // ~/.agents/skills is Codex's user skill folder; the older ~/.codex/skills would list the skill twice.
  skills: { dir: ".agents/skills" },
  skillInvocation: (name) => `$${name}`,
  setupNote:
    "Adds three hooks to ~/.codex/hooks.json: SessionStart gives each new session your Jarvis memory, PreCompact and SessionEnd save the conversation. Your other hooks are kept, and the file is backed up first. Codex runs new hooks only after you approve them: the next time Codex starts, choose Review hooks and trust the three Jarvis hooks. Codex remembers that trust by position, so after you disconnect it may ask you to review hooks that came after Jarvis's again.",
};

export const antigravity: AgentIntegration = {
  kind: "antigravity",
  label: "Antigravity",
  configFile: ".gemini/config/hooks.json",
  format: "named",
  rulesDir: ".gemini/config/rules",
  detect: (home) => anyExists(["/Applications/Antigravity.app", join(home, ".local/bin/agy"), join(home, ".gemini/antigravity"), join(home, ".gemini/antigravity-cli")]),
  // Antigravity has no session-end or compaction event; Stop fires after every turn.
  hookSpecs: (command) => [{ event: "Stop", command: command("turn-end"), timeout: 10 }],
  parseTranscript: parseAntigravity,
  // The global customizations root, read by the app and the agy CLI.
  skills: { dir: ".gemini/config/skills" },
  skillInvocation: (name) => `/${name}`,
  setupNote:
    "Adds a Jarvis entry to ~/.gemini/config/hooks.json that saves the conversation after each turn, and an always-on rule ~/.gemini/config/rules/jarvis-memory.md that gives each session your Jarvis memory. Other tools' hooks and rules are kept, and the hooks file is backed up first. Applies to the Antigravity app and the agy CLI.",
};

export const AGENT_INTEGRATIONS: AgentIntegration[] = [claudeCode, codex, antigravity];
export type AgentKind = AgentIntegration["kind"];
export const AGENT_KINDS = AGENT_INTEGRATIONS.map((a) => a.kind);
export const integrationFor = (kind: string) => AGENT_INTEGRATIONS.find((a) => a.kind === kind) ?? null;

/** How the owner knows a Harness: its integration's label, or the name it gave Jarvis. */
export const harnessLabel = (kind: string): string => integrationFor(kind)?.label ?? kind;
