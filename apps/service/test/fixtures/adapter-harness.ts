import type { AdapterContext, ConnectionRecord } from "../../src/connectors/types.ts";
import { createHttpClient } from "../../src/connectors/http.ts";
import { createLogger } from "../../src/core/log.ts";
import { createClaudeConnectorRunner } from "../../src/connectors/claude/runner.ts";
import type { ConnectionKind } from "@jarvis/contracts";

/** Build an adapter context whose endpoints point at a fixture server. */
export function fixtureContext(opts: {
  kind: ConnectionKind;
  baseUrl: string;
  secrets?: Record<string, string>;
  settings?: Record<string, unknown>;
  readScopes?: string[];
  writeActions?: string[];
  now?: Date;
  selfEmail?: string | null;
}): AdapterContext & { secrets: Map<string, string> } {
  const secrets = new Map(Object.entries(opts.secrets ?? {}));
  const connection: ConnectionRecord = {
    id: `${opts.kind}-test`,
    kind: opts.kind,
    label: opts.kind,
    status: "connected",
    settings: opts.settings ?? {},
    readScopes: opts.readScopes ?? [],
    writeActions: opts.writeActions ?? [],
    account: null,
  };
  const ctrl = new AbortController();
  return {
    connection,
    secrets,
    secret: async (n) => secrets.get(n) ?? null,
    setSecret: async (n, v) => {
      secrets.set(n, v);
    },
    http: createHttpClient({ signal: ctrl.signal, baseDelayMs: 5 }),
    log: createLogger(null, { quiet: true }),
    signal: ctrl.signal,
    now: () => opts.now ?? new Date("2026-09-30T10:00:00Z"),
    endpoint: () => opts.baseUrl,
    selfEmail: opts.selfEmail ?? null,
    claude: createClaudeConnectorRunner(createLogger(null, { quiet: true }), { pendingDelayMs: 10 }),
  };
}
