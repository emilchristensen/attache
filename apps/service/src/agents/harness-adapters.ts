import { existsSync } from "node:fs";
import type { HarnessApplyResult, HarnessCapabilities, HarnessFileChange, HarnessPreview, HarnessState, HarnessStatusReport, HarnessUninstallResult } from "@attache/contracts";
import { AGENT_INTEGRATIONS, type AgentIntegration } from "./integrations.ts";
import type { AgentHooks, HarnessStatus } from "./install.ts";
import { openCodeAdapter } from "./opencode-adapter.ts";
import { piAdapter } from "./pi-adapter.ts";

/**
 * The Harness integration boundary (ADR 0006): every Harness Connection is
 * detected, previewed, applied, checked, refreshed and removed through this
 * one shape, and each product's adapter owns how its files look.
 *
 * Every operation touches only this Attache instance's own files and entries.
 * A file the adapter cannot safely parse stops `preview`, `apply` and
 * `refresh` before anything is written; each existing file is backed up
 * before it changes.
 */
export interface HarnessAdapter {
  /** The Connection kind, e.g. `claude-code`. */
  kind: string;
  label: string;
  capabilities: HarnessCapabilities;
  /** Whether a running Harness must be restarted before an install or update takes effect. */
  restartRequired: boolean;
  /** Shown before the owner connects: what changes, and anything the Harness asks them to do. */
  setupNote: string;
  /** Whether the Harness is installed under the home folder whose settings Attache edits. */
  detect(home: string): boolean;
  /**
   * The owner may connect even when `detect` finds nothing, because Attache
   * cannot see every place the Harness installs to (e.g. an npm global folder).
   */
  manualSetup?: boolean;
  /** The changes `apply` would make; writes nothing. */
  preview(): HarnessPreview;
  /** Connect: write this instance's entries. Connecting again changes nothing. */
  apply(): HarnessApplyResult;
  status(): HarnessStatusReport;
  /** Bring stale or missing entries up to date, e.g. after an upgrade or a memory change; writes nothing when current. */
  refresh(): HarnessApplyResult;
  /** Disconnect: remove this instance's files and entries only, trying every part even when one fails. */
  uninstall(): HarnessUninstallResult;
}

/** What an existing integration can do, from how it is wired today. */
export function legacyCapabilities(a: AgentIntegration): HarnessCapabilities {
  if (!a.hooks) return { mcp: true, memory: "none", capture: "none" };
  const events = a.hooks.specs(() => "").map((s) => s.event);
  return {
    mcp: true,
    memory: a.hooks.rulesDir ? "managed-file" : "runtime-fresh",
    capture: events.includes("SessionEnd") ? "with-final-event" : "without-final-event",
  };
}

/** Harnesses that must be restarted to load a changed MCP configuration. */
const RESTART_REQUIRED = new Set(["claude-desktop"]);

/**
 * Claude Code, Codex, Antigravity and Claude Desktop behind the adapter
 * boundary, with their installation unchanged: the adapter delegates to
 * `AgentHooks`.
 */
export function legacyHarnessAdapter(a: AgentIntegration, hooks: AgentHooks, context: () => string): HarnessAdapter {
  const restartRequired = RESTART_REQUIRED.has(a.kind);
  const adapter: HarnessAdapter = {
    kind: a.kind,
    label: a.label,
    capabilities: legacyCapabilities(a),
    restartRequired,
    setupNote: a.setupNote,
    detect: (home) => a.detect(home),
    preview: () => ({ changes: hooks.preview(a, context()), restartRequired }),
    apply: () => {
      const changes = hooks.preview(a, context());
      const r = hooks.install(a, context());
      return { changes, backups: [r.backup, r.mcp.backup].filter((b): b is string => b !== null), restartRequired };
    },
    status: () => {
      try {
        const s = hooks.status(a);
        return { state: legacyState(s), message: harnessStatusMessage(s), files: [s.path, s.rules, s.mcp.path].filter((f): f is string => f !== null) };
      } catch (e) {
        return { state: "failed", message: (e as Error).message, files: [] };
      }
    },
    // Connecting is idempotent and replaces only stale Attache entries, so refreshing is applying again.
    refresh: () => adapter.apply(),
    uninstall: () => {
      const r = hooks.removeParts(a);
      const removed: HarnessFileChange[] = [
        ...(r.rules ? [{ path: r.rules, change: "remove" as const, backup: false, purpose: "your Attache memory, as an always-on rule" }] : []),
        ...(r.hooks.removed && r.hooks.path ? [{ path: r.hooks.path, change: "update" as const, backup: true, purpose: `Attache's hooks for ${a.label}` }] : []),
        ...(r.mcp ? [{ path: r.mcp, change: "update" as const, backup: true, purpose: "Attache's MCP server" }] : []),
      ];
      return { removed, failures: r.errors };
    },
  };
  return adapter;
}

/** Every Harness Attache can connect, as adapters. */
export function harnessAdapters(hooks: AgentHooks, context: () => string): HarnessAdapter[] {
  return [...AGENT_INTEGRATIONS.map((a) => legacyHarnessAdapter(a, hooks, context)), piAdapter(hooks), openCodeAdapter(hooks)];
}

/** `current` when everything matches, `stale` when every part is there but some are out of date, `missing` otherwise. */
function legacyState(s: HarnessStatus): HarnessState {
  if (s.current) return "current";
  const hooksThere = !s.path || s.installed.length > 0;
  const rulesThere = !s.rules || existsSync(s.rules);
  return hooksThere && rulesThere && s.mcp.registered ? "stale" : "missing";
}

/** "a, b and c". */
const list = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? ""));

/** What an existing integration has in place, or what is wrong with it and what to do. */
export function harnessStatusMessage(s: HarnessStatus): string {
  if (s.current) {
    const n = s.installed.length;
    return list([...(s.path ? [`${n} Attache hook${n === 1 ? "" : "s"} in ${s.path}`] : []), ...(s.rules ? [`memory rule ${s.rules}`] : []), `Attache's MCP server in ${s.mcp.path}`]);
  }
  const missing = [
    ...(s.hooksCurrent ? [] : s.installed.length ? [`the Attache hooks in ${s.path} are out of date`] : [`no Attache hooks in ${s.path}`]),
    ...(s.mcp.registered ? (s.mcp.current ? [] : [`Attache's MCP server in ${s.mcp.path} is out of date`]) : [`Attache's MCP server is not in ${s.mcp.path}`]),
  ];
  const what = missing.length ? list(missing) : `the memory rule ${s.rules} is missing`;
  return `${what.charAt(0).toUpperCase()}${what.slice(1)}. Set up again to fix it.`;
}
