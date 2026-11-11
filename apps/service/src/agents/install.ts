import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { defaultStateDir } from "../core/paths.ts";
import { platformLocations } from "../platform/locations.ts";
import { shellPath } from "../platform/shell-command.ts";
import { HooksFileError, ourHooks, replaceFile, ourNamedHooks, readSettings, sameHooks, withNamedHooks, withOurHooks, withoutNamedHooks, withoutOurHooks, writeSettings, type HookSpec } from "./hooks-config.ts";
import type { AgentIntegration } from "./integrations.ts";
import { McpRegistration } from "./mcp-registration.ts";
import type { McpServerEntry } from "./mcp-config.ts";

/** Home directory whose Harness settings Jarvis edits. Tests point this at a temporary folder. */
export function agentHome(): string {
  return process.env.JARVIS_AGENT_HOME || platformLocations().home;
}

/**
 * Prefer the installer's `current` symlink over a versioned app folder, so
 * hooks keep working after an upgrade replaces `app/<version>`.
 */
export function stablePath(p: string): string {
  const m = /^(.*)[\\/]app[\\/]([^\\/]+)[\\/](.*)$/.exec(p);
  if (!m) return p;
  const [, prefix, version, rest] = m as unknown as [string, string, string, string];
  const current = join(prefix, "current");
  try {
    if (existsSync(current) && realpathSync(current) === realpathSync(join(prefix, "app", version))) return join(current, rest);
  } catch {
    // Fall back to the exact path.
  }
  return p;
}

/** The hook script next to the running service: the bundled .mjs in releases, the TypeScript source in development. */
export function hookScript(): string {
  if (process.env.JARVIS_AGENT_HOOK_SCRIPT) return process.env.JARVIS_AGENT_HOOK_SCRIPT;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "jarvis-agent-hook.mjs"), join(here, "jarvis-agent-hook.ts")]) if (existsSync(candidate)) return candidate;
  throw new Error(`The Jarvis agent hook script is missing next to ${here}`);
}

/** The script behind this install's `jarvis` command: the bundled service in releases, `JARVIS_CLI_SCRIPT` in tests and development. */
function cliScript(): string {
  return process.env.JARVIS_CLI_SCRIPT || (process.argv[1] && /jarvis-service\.mjs$/.test(process.argv[1]) ? process.argv[1] : "");
}

/**
 * How a Harness starts Jarvis's MCP server for this install: `jarvis mcp`
 * pinned to its state folder, through the bundled runtime and the installer's
 * stable `current` path when there is one, so it needs nothing on PATH.
 */
export function mcpServerEntry(stateDir: string): McpServerEntry {
  const script = cliScript();
  const args = ["mcp", "--state-dir", stateDir];
  return script ? { command: stablePath(process.execPath), args: [stablePath(script), ...args] } : { command: "jarvis", args };
}

const RULE_MARKER = "<!-- managed by Jarvis: this file is rewritten when your memory changes, and removed when you disconnect -->";

/** Turn the memory context into an always-on rule file (Antigravity's rule format). */
export function ruleFileText(context: string): string {
  return `---\ntrigger: always_on\ndescription: Jarvis memory for this user\n---\n${RULE_MARKER}\n\n${context.trim()}\n`;
}

/** What is installed in one Harness. */
export interface HarnessStatus {
  /** The hooks file, or null for a Harness without hooks. */
  path: string | null;
  installed: HookSpec[];
  /** The hooks match what this version would write; true for a Harness without hooks. */
  hooksCurrent: boolean;
  rules: string | null;
  mcp: { path: string; registered: boolean; current: boolean };
  /** Everything matches what this version would write. */
  current: boolean;
}

/**
 * Connecting a Harness: Jarvis's MCP server in its MCP configuration and, for
 * a Harness with hooks, the hooks and (where it has no session-start hook) an
 * always-on memory rule. Only Jarvis's own entries are touched, each file is
 * backed up first, and a file Jarvis cannot parse stops the change before
 * anything is written.
 */
export class AgentHooks {
  private readonly stateDir: string;
  private readonly backupDir: string;
  /** Jarvis's MCP server in each Harness's configuration. */
  readonly mcp: McpRegistration;

  constructor(stateDir: string, backupDir: string) {
    this.stateDir = stateDir;
    this.backupDir = backupDir;
    this.mcp = new McpRegistration({ stateDir, backupDir, home: agentHome, name: () => this.ownerKey(), entry: () => mcpServerEntry(stateDir) });
  }

  configPath(a: AgentIntegration): string | null {
    return a.hooks ? join(agentHome(), a.hooks.configFile) : null;
  }

  /** One rule file per Jarvis instance: `jarvis-memory.md` for the default install. */
  rulesPath(a: AgentIntegration): string | null {
    return a.hooks?.rulesDir ? join(agentHome(), a.hooks.rulesDir, `${this.ownerKey()}-memory.md`) : null;
  }

  /** Only hooks that point at this Jarvis instance's state folder are ours; another instance's are foreign. */
  isOurs = (command: string): boolean => command.includes("jarvis-agent-hook") && command.includes(shellPath(this.stateDir));

  /** Owner key for `named` hook files and the MCP server's name: plain "jarvis" for the default install, distinct for any other instance. */
  ownerKey(): string {
    return this.stateDir === defaultStateDir() ? "jarvis" : `jarvis-${createHash("sha256").update(this.stateDir).digest("hex").slice(0, 8)}`;
  }

  expected(a: AgentIntegration): HookSpec[] {
    if (!a.hooks) return [];
    const node = stablePath(process.execPath);
    const script = stablePath(hookScript());
    return a.hooks.specs((event) => `${shellPath(node)} ${shellPath(script)} ${a.kind} ${event} --state-dir ${shellPath(this.stateDir)}`);
  }

  private installed(a: AgentIntegration, settings: Record<string, unknown>): HookSpec[] {
    return a.hooks?.format === "named" ? ourNamedHooks(settings, this.isOurs) : ourHooks(settings, this.isOurs);
  }

  status(a: AgentIntegration): HarnessStatus {
    const path = this.configPath(a);
    const installed = path ? this.installed(a, readSettings(path)) : [];
    const rules = this.rulesPath(a);
    const rulesOk = !rules || (existsSync(rules) && readFileSync(rules, "utf8").includes(RULE_MARKER));
    const hooksOk = !a.hooks || (installed.length > 0 && sameHooks(installed, this.expected(a)));
    const mcp = this.mcp.status(a);
    return { path, installed, hooksCurrent: hooksOk, rules, mcp, current: hooksOk && rulesOk && mcp.current };
  }

  /** The hooks file with exactly this install's hooks; null for a Harness without hooks. */
  private planHooks(a: AgentIntegration): { path: string; before: Record<string, unknown>; next: Record<string, unknown> } | null {
    const path = this.configPath(a);
    if (!path || !a.hooks) return null;
    const before = readSettings(path);
    const hooks = this.expected(a);
    const next = a.hooks.format === "named" ? withNamedHooks(before, this.ownerKey(), hooks, this.isOurs) : withOurHooks(before, hooks, this.isOurs);
    return { path, before, next };
  }

  install(a: AgentIntegration, context: string): { path: string | null; backup: string | null; hooks: HookSpec[]; mcp: { path: string; backup: string | null } } {
    // Every change is worked out first: a file Jarvis must not change stops the connection before anything is written.
    const hooks = this.planHooks(a);
    const mcp = this.mcp.planInstall(a);
    this.checkRules(a);
    const mcpWritten = this.mcp.apply(mcp);
    this.writeRules(a, context);
    const backup = hooks && JSON.stringify(hooks.next) !== JSON.stringify(hooks.before) ? writeSettings(hooks.path, hooks.next, this.backupDir).backup : null;
    return { path: hooks?.path ?? null, backup, hooks: this.expected(a), mcp: { path: mcpWritten.path, backup: mcpWritten.backup } };
  }

  private checkRules(a: AgentIntegration) {
    const rules = this.rulesPath(a);
    if (rules && existsSync(rules) && !readFileSync(rules, "utf8").includes(RULE_MARKER)) throw new HooksFileError(`${rules} exists and was not written by Jarvis; Jarvis will not change it.`);
  }

  /** Keep a Harness's rule file in step with the memory context. Never replaces a file Jarvis did not write. */
  writeRules(a: AgentIntegration, context: string) {
    const rules = this.rulesPath(a);
    if (!rules) return;
    this.checkRules(a);
    const text = ruleFileText(context);
    if (existsSync(rules) && readFileSync(rules, "utf8") === text) return;
    replaceFile(rules, text);
  }

  /** Register the MCP server where it is missing or out of date, e.g. after an upgrade. Writes nothing when it is current. */
  refreshMcp(a: AgentIntegration): { path: string; changed: boolean } {
    const r = this.mcp.apply(this.mcp.planInstall(a));
    return { path: r.path, changed: r.changed };
  }

  /** Remove this install from every Harness, one at a time, so a file Jarvis cannot edit does not stop the rest. */
  uninstallAll(agents: AgentIntegration[]): Array<{ agent: string; path: string | null; removed: number; mcp: string | null; error?: string }> {
    return agents.map((a) => {
      try {
        const { backup: _backup, ...r } = this.uninstall(a);
        return { agent: a.kind, ...r };
      } catch (e) {
        return { agent: a.kind, path: this.configPath(a), removed: 0, mcp: null, error: (e as Error).message };
      }
    });
  }

  /**
   * Remove the hooks, the memory rule and the MCP server. Each part is tried
   * even when another fails; the failures are reported together afterwards.
   */
  uninstall(a: AgentIntegration): { path: string | null; removed: number; backup: string | null; mcp: string | null } {
    const errors: string[] = [];
    const attempt = <T>(fallback: T, run: () => T): T => {
      try {
        return run();
      } catch (e) {
        errors.push((e as Error).message);
        return fallback;
      }
    };
    attempt(undefined, () => this.removeRules(a));
    const hooks = attempt({ path: this.configPath(a), removed: 0, backup: null as string | null }, () => this.uninstallHooks(a));
    const mcp = attempt(null as string | null, () => {
      const r = this.mcp.apply(this.mcp.planUninstall(a));
      return r.changed ? r.path : null;
    });
    if (errors.length) throw new HooksFileError(errors.join(" "));
    return { ...hooks, mcp };
  }

  private removeRules(a: AgentIntegration) {
    const rules = this.rulesPath(a);
    if (rules && existsSync(rules) && readFileSync(rules, "utf8").includes(RULE_MARKER)) rmSync(rules);
  }

  private uninstallHooks(a: AgentIntegration): { path: string | null; removed: number; backup: string | null } {
    const path = this.configPath(a);
    if (!path || !a.hooks || !existsSync(path)) return { path, removed: 0, backup: null };
    const before = readSettings(path);
    const removed = this.installed(a, before).length;
    if (!removed) return { path, removed: 0, backup: null };
    const next = a.hooks.format === "named" ? withoutNamedHooks(before, this.isOurs) : withoutOurHooks(before, this.isOurs);
    return { path, removed, backup: writeSettings(path, next, this.backupDir).backup };
  }
}
