import type { ConnectorAdapter } from "./types.ts";
import { RemoteError } from "./http.ts";
import type { AgentIntegration } from "../agents/integrations.ts";
import { agentHome, type AgentHooks } from "../agents/install.ts";
import { harnessStatusMessage } from "../agents/harness-adapters.ts";
import { HooksFileError } from "../agents/hooks-config.ts";

/**
 * A Harness as a connection. Connecting registers Attache's MCP server in the
 * Harness's configuration and, for a Harness with hooks, installs this
 * Attache's hooks; disconnecting removes both (see App wiring). The test checks
 * that everything is present and points at this install.
 */
export function agentAdapter(a: AgentIntegration, hooks: AgentHooks, context: () => string): ConnectorAdapter {
  const notFound = `${a.label} was not found on this Machine.`;
  return {
    kind: a.kind,
    secretNames: [],
    definition: {
      kind: a.kind,
      label: a.label,
      description: a.hooks
        ? `Reach your Brain from ${a.label} through Attache's MCP server, save your ${a.label} sessions in the Brain, and give each new session your Attache memory.`
        : `Reach your Brain from ${a.label} through Attache's MCP server: search, read, save and audit, and the save, audit and wrap-up prompts.`,
      authMethods: [a.hooks ? { id: "hooks", label: "MCP server and hooks", fields: [] } : { id: "mcp", label: "MCP server", fields: [] }],
      scopes: [],
      writeActions: [],
      setupHelp: a.setupNote,
      unavoidableSteps: [],
    },
    async configure() {
      if (!a.detect(agentHome())) throw new RemoteError(`${notFound} Install it, then connect it here.`, "not_configured");
      try {
        const r = hooks.install(a, context());
        return { authMethod: a.hooks ? "hooks" : "mcp", configPath: r.path ?? r.mcp.path, mcpConfigPath: r.mcp.path, backup: r.backup, mcpBackup: r.mcp.backup };
      } catch (e) {
        // A configuration file Attache cannot safely edit is the owner's to fix; say exactly which and why.
        throw new RemoteError(e instanceof HooksFileError ? e.message : `Could not set up ${a.label}: ${(e as Error).message}`, "error");
      }
    },
    async test() {
      if (!a.detect(agentHome())) return { ok: false, state: "not_configured", account: null, message: notFound };
      try {
        const s = hooks.status(a);
        return { ok: s.current, state: s.current ? "complete" : "error", account: s.path ?? s.mcp.path, message: harnessStatusMessage(s) };
      } catch (e) {
        return { ok: false, state: "error", account: null, message: (e as Error).message };
      }
    },
  };
}
