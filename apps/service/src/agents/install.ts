import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { defaultStateDir } from "../core/paths.ts";
import { HooksFileError, ourHooks, replaceFile, ourNamedHooks, readSettings, sameHooks, withNamedHooks, withOurHooks, withoutNamedHooks, withoutOurHooks, writeSettings, type HookSpec } from "./hooks-config.ts";
import type { AgentIntegration } from "./integrations.ts";
import { AgentSkills } from "./skills.ts";

/** Home directory whose agent settings Jarvis edits. Tests point this at a temporary folder. */
export function agentHome(): string {
  return process.env.JARVIS_AGENT_HOME || process.env.HOME || homedir();
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Prefer the installer's `current` symlink over a versioned app folder, so
 * hooks keep working after an upgrade replaces `app/<version>`.
 */
export function stablePath(p: string): string {
  const m = /^(.*)\/app\/([^/]+)\/(.*)$/.exec(p);
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

/**
 * The `jarvis` command line of this install, pinned to its state folder, for
 * agents to run: the bundled service in releases, `JARVIS_CLI_SCRIPT` when set
 * (tests, development), otherwise `jarvis` on PATH.
 */
export function cliCommand(stateDir: string): string {
  const script = process.env.JARVIS_CLI_SCRIPT || (process.argv[1] && /jarvis-service\.mjs$/.test(process.argv[1]) ? process.argv[1] : "");
  const env = `JARVIS_STATE_DIR=${quote(stateDir)}`;
  return script ? `${env} ${quote(stablePath(process.execPath))} ${quote(stablePath(script))}` : `${env} jarvis`;
}

const RULE_MARKER = "<!-- managed by Jarvis: this file is rewritten when your memory changes, and removed when you disconnect -->";

/** Turn the memory context into an always-on rule file (Antigravity's rule format). */
export function ruleFileText(context: string): string {
  return `---\ntrigger: always_on\ndescription: Jarvis memory for this user\n---\n${RULE_MARKER}\n\n${context.trim()}\n`;
}

export class AgentHooks {
  private readonly stateDir: string;
  private readonly backupDir: string;
  /** The user-invoked save and audit skills installed alongside the hooks. */
  readonly skills: AgentSkills;

  constructor(stateDir: string, backupDir: string) {
    this.stateDir = stateDir;
    this.backupDir = backupDir;
    this.skills = new AgentSkills({ home: agentHome, stateDir, owner: () => this.ownerKey(), cli: () => cliCommand(stateDir) });
  }

  configPath(a: AgentIntegration): string {
    return join(agentHome(), a.configFile);
  }

  /** One rule file per Jarvis instance: `jarvis-memory.md` for the default install. */
  rulesPath(a: AgentIntegration): string | null {
    return a.rulesDir ? join(agentHome(), a.rulesDir, `${this.ownerKey()}-memory.md`) : null;
  }

  /** Only hooks that point at this Jarvis instance's state folder are ours; another instance's are foreign. */
  isOurs = (command: string): boolean => command.includes("jarvis-agent-hook") && command.includes(quote(this.stateDir));

  /** Owner key for `named` hook files: plain "jarvis" for the default install, distinct for any other instance. */
  ownerKey(): string {
    return this.stateDir === defaultStateDir() ? "jarvis" : `jarvis-${createHash("sha256").update(this.stateDir).digest("hex").slice(0, 8)}`;
  }

  expected(a: AgentIntegration): HookSpec[] {
    const node = stablePath(process.execPath);
    const script = stablePath(hookScript());
    return a.hookSpecs((event) => `${quote(node)} ${quote(script)} ${a.kind} ${event} --state-dir ${quote(this.stateDir)}`);
  }

  private installed(a: AgentIntegration, settings: Record<string, unknown>): HookSpec[] {
    return a.format === "named" ? ourNamedHooks(settings, this.isOurs) : ourHooks(settings, this.isOurs);
  }

  status(a: AgentIntegration): { path: string; installed: HookSpec[]; current: boolean; rules: string | null; skills: string[] } {
    const path = this.configPath(a);
    const installed = this.installed(a, readSettings(path));
    const rules = this.rulesPath(a);
    const rulesOk = !rules || (existsSync(rules) && readFileSync(rules, "utf8").includes(RULE_MARKER));
    const skills = this.skills.status(a);
    return { path, installed, current: installed.length > 0 && sameHooks(installed, this.expected(a)) && rulesOk && skills.current, rules, skills: skills.folders };
  }

  install(a: AgentIntegration, context: string): { path: string; backup: string | null; hooks: HookSpec[] } {
    const path = this.configPath(a);
    const before = readSettings(path);
    const hooks = this.expected(a);
    const next = a.format === "named" ? withNamedHooks(before, this.ownerKey(), hooks, this.isOurs) : withOurHooks(before, hooks, this.isOurs);
    // Skills first: a skill folder Jarvis must not replace stops the connection before anything changes.
    this.skills.install(a);
    this.writeRules(a, context);
    if (JSON.stringify(next) === JSON.stringify(before)) return { path, backup: null, hooks };
    return { path, backup: writeSettings(path, next, this.backupDir).backup, hooks };
  }

  /** Keep an agent's rule file in step with the memory context. Never replaces a file Jarvis did not write. */
  writeRules(a: AgentIntegration, context: string) {
    const rules = this.rulesPath(a);
    if (!rules) return;
    if (existsSync(rules) && !readFileSync(rules, "utf8").includes(RULE_MARKER)) throw new HooksFileError(`${rules} exists and was not written by Jarvis; Jarvis will not change it.`);
    const text = ruleFileText(context);
    if (existsSync(rules) && readFileSync(rules, "utf8") === text) return;
    replaceFile(rules, text);
  }

  /** Remove this install's hooks from every agent, one at a time, so a file Jarvis cannot edit does not stop the rest. */
  uninstallAll(agents: AgentIntegration[]): Array<{ agent: string; path: string; removed: number; error?: string }> {
    return agents.map((a) => {
      try {
        return { agent: a.kind, ...this.uninstall(a) };
      } catch (e) {
        return { agent: a.kind, path: this.configPath(a), removed: 0, error: (e as Error).message };
      }
    });
  }

  uninstall(a: AgentIntegration): { path: string; removed: number; backup: string | null } {
    const rules = this.rulesPath(a);
    if (rules && existsSync(rules) && readFileSync(rules, "utf8").includes(RULE_MARKER)) rmSync(rules);
    this.skills.uninstall(a);
    const path = this.configPath(a);
    if (!existsSync(path)) return { path, removed: 0, backup: null };
    const before = readSettings(path);
    const removed = this.installed(a, before).length;
    if (!removed) return { path, removed: 0, backup: null };
    const next = a.format === "named" ? withoutNamedHooks(before, this.isOurs) : withoutOurHooks(before, this.isOurs);
    return { path, removed, backup: writeSettings(path, next, this.backupDir).backup };
  }
}
