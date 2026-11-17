import type { ConnectorAdapter, TestResult } from "./types.ts";
import { RemoteError } from "./http.ts";
import type { AgentIntegration } from "../agents/integrations.ts";
import { agentHome, type AgentHooks, type HarnessStatus } from "../agents/install.ts";
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
        return describe(hooks.status(a));
      } catch (e) {
        return { ok: false, state: "error", account: null, message: (e as Error).message };
      }
    },
  };
}

/** "a, b and c". */
const list = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? ""));

function describe(s: HarnessStatus): TestResult {
  const account = s.path ?? s.mcp.path;
  if (s.current) {
    const n = s.installed.length;
    const parts = [...(s.path ? [`${n} Attache hook${n === 1 ? "" : "s"} in ${s.path}`] : []), ...(s.rules ? [`memory rule ${s.rules}`] : []), `Attache's MCP server in ${s.mcp.path}`];
    return { ok: true, state: "complete", account, message: list(parts) };
  }
  const missing = [
    ...(s.hooksCurrent ? [] : s.installed.length ? [`the Attache hooks in ${s.path} are out of date`] : [`no Attache hooks in ${s.path}`]),
    ...(s.mcp.registered ? (s.mcp.current ? [] : [`Attache's MCP server in ${s.mcp.path} is out of date`]) : [`Attache's MCP server is not in ${s.mcp.path}`]),
  ];
  const what = missing.length ? list(missing) : `the memory rule ${s.rules} is missing`;
  return { ok: false, state: "error", account, message: `${what.charAt(0).toUpperCase()}${what.slice(1)}. Set up again to fix it.` };
}
