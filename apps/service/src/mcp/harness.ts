import type { Implementation } from "@modelcontextprotocol/sdk/types.js";
import { slugify } from "../memory/markdown.ts";

/** The Harness on the other end of an MCP connection, in Jarvis's words. */
export interface HarnessIdentity {
  /** Stable id, the Harness kind Jarvis knows it by when it knows it, e.g. `claude-code`. */
  id: string;
  /** What the owner calls it, e.g. "Claude Desktop". */
  label: string;
}

/** The names Harnesses give themselves when they connect, mapped to the Harnesses Jarvis knows. */
const KNOWN_CLIENTS: Record<string, HarnessIdentity> = {
  "claude-code": { id: "claude-code", label: "Claude Code" },
  "claude-ai": { id: "claude-desktop", label: "Claude Desktop" },
  "codex-mcp-client": { id: "codex", label: "Codex" },
  codex: { id: "codex", label: "Codex" },
  antigravity: { id: "antigravity", label: "Antigravity" },
};

const UNKNOWN: HarnessIdentity = { id: "unknown-harness", label: "an unknown Harness" };
const ID_MAX = 40;
const LABEL_MAX = 80;

/**
 * Who connected, from the client information the Harness sent when it
 * connected. A Harness Jarvis does not know keeps the name it gave itself.
 */
export function harnessOf(client: Implementation | undefined): HarnessIdentity {
  if (!client?.name.trim()) return UNKNOWN;
  const known = KNOWN_CLIENTS[client.name.trim().toLowerCase()];
  if (known) return known;
  const id = slugify(client.name).slice(0, ID_MAX) || UNKNOWN.id;
  const label = (client.title?.trim() || client.name.trim()).replace(/\s+/g, " ").slice(0, LABEL_MAX);
  return { id, label };
}
