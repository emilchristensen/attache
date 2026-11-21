import { integrationFor } from "./integrations.ts";
import { parseOpenCode } from "./opencode-transcript.ts";
import type { ParsedSession } from "./transcripts.ts";

/**
 * Where the service learns how to read a Harness's spooled sessions: the
 * hook Harnesses' own transcript parsers, plus Harnesses whose plugin spools
 * snapshots itself.
 */
export interface SessionSource {
  label: string;
  parse(raw: string): ParsedSession;
  /**
   * True when one snapshot may hold only part of a session (OpenCode 2 drops
   * messages from what it hands a plugin once they are compacted): the service
   * joins snapshots by the turns' message ids instead of taking the newest.
   */
  partial?: true;
}

const PLUGIN_SOURCES: Record<string, SessionSource> = {
  opencode: { label: "OpenCode", parse: parseOpenCode, partial: true },
};

export function sessionSourceFor(kind: string): SessionSource | null {
  const hooks = integrationFor(kind);
  if (hooks?.hooks) return { label: hooks.label, parse: hooks.hooks.parseTranscript };
  return PLUGIN_SOURCES[kind] ?? null;
}

export const PARTIAL_SOURCE_KINDS = Object.keys(PLUGIN_SOURCES).filter((k) => PLUGIN_SOURCES[k]!.partial);
