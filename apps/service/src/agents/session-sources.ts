import { parseCopilotCli } from "./copilot-cli-transcript.ts";
import { integrationFor } from "./integrations.ts";
import { parseOpenCode } from "./opencode-transcript.ts";
import { parsePi } from "./pi-transcript.ts";
import type { ParsedSession } from "./transcripts.ts";

/**
 * Where the service learns how to read a Harness's spooled sessions: the
 * hook Harnesses' own transcript parsers, plus the Harnesses connected
 * through their own adapters (ADR 0006): plugins that spool snapshots
 * themselves, and Copilot CLI, whose hooks copy its transcript.
 */
export interface SessionSource {
  label: string;
  parse(raw: string): ParsedSession;
  /**
   * True when one snapshot may hold only part of a session (OpenCode 2 drops
   * messages from what it hands a plugin once they are compacted; Pi hands
   * only the current branch, and a cloned session only what follows its
   * parent): the service joins snapshots by the turns' message ids instead
   * of taking the newest.
   */
  partial?: true;
  /**
   * True when the parser names a problem for anything it cannot read, so a
   * transcript that gives no turns and no problem had nothing said in it
   * (Copilot CLI writes its file before the first prompt): no failure.
   */
  strict?: true;
}

const MANAGED_SOURCES: Record<string, SessionSource> = {
  opencode: { label: "OpenCode", parse: parseOpenCode, partial: true },
  pi: { label: "Pi", parse: parsePi, partial: true },
  // Copilot CLI's hooks copy its whole events.jsonl, which it only appends to: each copy holds every earlier one.
  "copilot-cli": { label: "Copilot CLI", parse: parseCopilotCli, strict: true },
};

export function sessionSourceFor(kind: string): SessionSource | null {
  const hooks = integrationFor(kind);
  if (hooks?.hooks) return { label: hooks.label, parse: hooks.hooks.parseTranscript };
  return MANAGED_SOURCES[kind] ?? null;
}

export const MANAGED_SOURCE_KINDS = Object.keys(MANAGED_SOURCES);
