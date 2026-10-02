import type { ConnectorAdapter } from "./types.ts";
import { RemoteError } from "./http.ts";
import type { AgentIntegration } from "../agents/integrations.ts";
import { agentHome, type AgentHooks } from "../agents/install.ts";
import { HooksFileError } from "../agents/hooks-config.ts";

/**
 * A coding agent as a connection. Connecting installs this Jarvis's hooks in
 * the agent's settings; disconnecting removes them (see App wiring). The test
 * checks that the hooks are present and point at this install.
 */
export function agentAdapter(a: AgentIntegration, hooks: AgentHooks, context: () => string): ConnectorAdapter {
  return {
    kind: a.kind,
    secretNames: [],
    definition: {
      kind: a.kind,
      label: a.label,
      description: `Save your ${a.label} sessions in your data folder, give each new session your Jarvis memory${a.skills ? `, and add the ${skillNames(a, hooks)} skills` : ""}.`,
      authMethods: [{ id: "hooks", label: `Hooks in ~/${a.configFile}`, fields: [] }],
      scopes: [],
      writeActions: [],
      setupHelp: `${a.setupNote}${a.skills ? ` Also adds two skills that only you can run, ${skillNames(a, hooks)}, in ~/${a.skills.dir}; other skills there are left alone.` : ""}`,
      unavoidableSteps: [],
    },
    async configure() {
      if (!a.detect(agentHome())) throw new RemoteError(`${a.label} was not found on this Mac. Install it, then connect it here.`, "not_configured");
      try {
        const r = hooks.install(a, context());
        return { authMethod: "hooks", configPath: r.path, backup: r.backup };
      } catch (e) {
        // A settings file Jarvis cannot safely edit is the user's to fix; say exactly which and why.
        throw new RemoteError(e instanceof HooksFileError ? e.message : `Could not add the hooks: ${(e as Error).message}`, "error");
      }
    },
    async test() {
      if (!a.detect(agentHome())) return { ok: false, state: "not_configured", account: null, message: `${a.label} was not found on this Mac.` };
      try {
        const s = hooks.status(a);
        if (s.current) return { ok: true, state: "complete", account: s.path, message: `${s.installed.length} Jarvis hook${s.installed.length === 1 ? "" : "s"} in ${s.path}${s.rules ? `, memory rule ${s.rules}` : ""}${s.skills.length ? `, and the ${skillNames(a, hooks)} skills` : ""}` };
        return { ok: false, state: "error", account: s.path, message: s.installed.length ? `The Jarvis hooks in ${s.path} are out of date. Set up again to update them.` : `No Jarvis hooks in ${s.path}. Set up again to add them.` };
      } catch (e) {
        return { ok: false, state: "error", account: null, message: (e as Error).message };
      }
    },
  };
}

/** How the user types this install's skills in agent `a`: `/jarvis-save and /jarvis-audit`. */
const skillNames = (a: AgentIntegration, hooks: AgentHooks) =>
  hooks.skills
    .names()
    .map((n) => a.skillInvocation(n))
    .join(" and ");
