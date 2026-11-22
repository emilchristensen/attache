import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
import type { MemorySaveInput } from "@attache/contracts";
import { agentFromEnv } from "./agent-env.ts";
import { slugify } from "../memory/markdown.ts";

/** The Harness on the other end of an MCP connection, in Attache's words. */
export interface HarnessIdentity {
  /** Stable id, the Harness kind Attache knows it by when it knows it, e.g. `claude-code`. */
  id: string;
  /** What the owner calls it, e.g. "Claude Desktop". */
  label: string;
}

/** The Harness that called a tool, and its session when the Harness names one. */
export interface HarnessSession {
  harness: HarnessIdentity;
  sessionId?: string;
}

/** Where the server runs: the environment and folder its Harness started it with. */
export interface ServerContext {
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export type SaveOrigin = NonNullable<MemorySaveInput["origin"]>;

const CLAUDE_CODE: HarnessIdentity = { id: "claude-code", label: "Claude Code" };
const CLAUDE_DESKTOP: HarnessIdentity = { id: "claude-desktop", label: "Claude Desktop" };
const CODEX: HarnessIdentity = { id: "codex", label: "Codex" };
const ANTIGRAVITY: HarnessIdentity = { id: "antigravity", label: "Antigravity" };
const PI: HarnessIdentity = { id: "pi", label: "Pi" };
const OPENCODE: HarnessIdentity = { id: "opencode", label: "OpenCode" };
const COPILOT_CLI: HarnessIdentity = { id: "copilot-cli", label: "Copilot CLI" };

/** The Harnesses Attache knows, by id. */
const KNOWN_IDS: Record<string, HarnessIdentity> = Object.fromEntries([CLAUDE_CODE, CLAUDE_DESKTOP, CODEX, ANTIGRAVITY, PI, OPENCODE, COPILOT_CLI].map((h) => [h.id, h]));

/** What the owner calls a Harness Attache knows by its id, or null for any other id. */
export const knownHarnessLabel = (id: string): string | null => KNOWN_IDS[id]?.label ?? null;

/** The names Harnesses give themselves when they connect, mapped to the Harnesses Attache knows. */
const KNOWN_CLIENTS: Record<string, HarnessIdentity> = {
  "claude-code": CLAUDE_CODE,
  "claude-ai": CLAUDE_DESKTOP,
  "codex-mcp-client": CODEX,
  codex: CODEX,
  antigravity: ANTIGRAVITY,
  // Pi's built-in MCP client names itself "pi" (earendil-works/pi packages/coding-agent/src/extensions/mcp/runtime.ts).
  pi: PI,
  // OpenCode 1 and 2 both name their MCP client "opencode" (seen from opencode-ai 1.19.6 and @opencode/cli 2.3.2).
  opencode: OPENCODE,
  // Copilot CLI names its MCP client "copilot-cli" (seen from Copilot CLI 1.0.114, offline with a stand-in model).
  "copilot-cli": COPILOT_CLI,
};

const UNKNOWN: HarnessIdentity = { id: "unknown-harness", label: "an unknown Harness" };
const ID_MAX = 40;
const LABEL_MAX = 80;
const SESSION_MAX = 200;
const CWD_MAX = 2000;

/**
 * Who connected, from the client information the Harness sent when it
 * connected. A Harness Attache does not know keeps the name it gave itself.
 */
export function harnessOf(client: Implementation | undefined): HarnessIdentity {
  if (!client?.name.trim()) return UNKNOWN;
  const known = KNOWN_CLIENTS[client.name.trim().toLowerCase()];
  if (known) return known;
  const id = slugify(client.name).slice(0, ID_MAX) || UNKNOWN.id;
  const label = (client.title?.trim() || client.name.trim()).replace(/\s+/g, " ").slice(0, LABEL_MAX);
  return { id, label };
}

/**
 * Which Harness and session a tool call comes from. A Harness that starts the
 * server per session names both in the environment it gives the server, which
 * is the more precise answer; otherwise the client information it sent when it
 * connected identifies the Harness, without a session.
 */
export function harnessSession(env: NodeJS.ProcessEnv, client: Implementation | undefined): HarnessSession {
  const fromEnv = agentFromEnv(env);
  if (!fromEnv) return { harness: harnessOf(client) };
  const harness = KNOWN_IDS[fromEnv.agent] ?? { id: fromEnv.agent, label: fromEnv.agent };
  return { harness, ...(fromEnv.sessionId ? { sessionId: fromEnv.sessionId.slice(0, SESSION_MAX) } : {}) };
}

/** The origin a save records: the Harness, its session, and the folder it worked in. */
export function saveOrigin(caller: HarnessSession, cwd: string): SaveOrigin {
  return { agent: caller.harness.id, ...(caller.sessionId ? { sessionId: caller.sessionId } : {}), cwd: cwd.slice(0, CWD_MAX) };
}
