import type { ConnectionKind } from "@attache/contracts";
import type { ConnectorAdapter } from "./types.ts";
import { RemoteError } from "./http.ts";
import { agentHome } from "../agents/install.ts";
import type { HarnessAdapter } from "../agents/harness-adapters.ts";
import { HooksFileError } from "../agents/hooks-config.ts";

/**
 * A Harness as a connection, driven through its adapter (ADR 0006). Connecting
 * applies the adapter: Attache's MCP server and, where the Harness has them,
 * hooks or a memory rule; connecting again refreshes stale entries and changes
 * nothing that is current. Disconnecting uninstalls (see App wiring). The test
 * reads the adapter's status: everything present and pointing at this install.
 */
export function agentAdapter(h: HarnessAdapter): ConnectorAdapter {
  const notFound = `${h.label} was not found on this Machine.`;
  const lifecycle = h.capabilities.memory !== "none" || h.capabilities.capture !== "none";
  return {
    kind: h.kind as ConnectionKind,
    secretNames: [],
    harness: h,
    definition: {
      kind: h.kind as ConnectionKind,
      label: h.label,
      description: lifecycle
        ? `Reach your Brain from ${h.label} through Attache's MCP server, save your ${h.label} sessions in the Brain, and give each new session your Attache memory.`
        : `Reach your Brain from ${h.label} through Attache's MCP server: search, read, save and audit, and the save, audit and wrap-up prompts.`,
      authMethods: [lifecycle ? { id: "hooks", label: "MCP server and hooks", fields: [] } : { id: "mcp", label: "MCP server", fields: [] }],
      scopes: [],
      writeActions: [],
      setupHelp: h.setupNote,
      unavoidableSteps: [],
      harness: { capabilities: h.capabilities, restartRequired: h.restartRequired },
    },
    async configure() {
      // A Harness Attache cannot always find (manualSetup) is still connected when the owner asks.
      if (!h.manualSetup && !h.detect(agentHome())) throw new RemoteError(`${notFound} Install it, then connect it here.`, "not_configured");
      try {
        const r = h.apply();
        return { authMethod: lifecycle ? "hooks" : "mcp", configPath: h.status().files[0] ?? null, changed: r.changes.map((c) => c.path), backups: r.backups, restartRequired: r.restartRequired };
      } catch (e) {
        // A configuration file Attache cannot safely edit is the owner's to fix; say exactly which and why.
        throw new RemoteError(e instanceof HooksFileError ? e.message : `Could not set up ${h.label}: ${(e as Error).message}`, "error");
      }
    },
    async test() {
      const s = h.status();
      if (!h.detect(agentHome()) && !(h.manualSetup && s.state !== "missing")) {
        return { ok: false, state: "not_configured", account: null, message: h.manualSetup ? `${notFound} If it is installed somewhere Attache does not look, connect it here anyway.` : notFound };
      }
      return { ok: s.state === "current", state: s.state === "current" ? "complete" : "error", account: s.state === "failed" ? null : (s.files[0] ?? null), message: s.message };
    },
  };
}
