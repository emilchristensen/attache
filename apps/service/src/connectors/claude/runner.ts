/**
 * The seam adapters use to reach claude.ai connectors. The default runner
 * spawns the user's own Claude Code CLI (see session.ts); tests substitute
 * the CLI with a fixture binary through JARVIS_CLAUDE_BIN, so the protocol
 * handling below is exercised for real.
 */
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { RemoteError } from "../http.ts";
import type { Logger } from "../../core/log.ts";
import { findClaudeCli } from "../../models/providers.ts";
import { platformLocations } from "../../platform/locations.ts";
import { run as runTool } from "../../platform/run.ts";
import { preApprovingRules, serverPrefix, type CallOutcome, type PlannedCall } from "./plan.ts";
import { claudeLaunch, CONNECTOR_CWD, PromptTooLongError, runSession } from "./session.ts";

export interface ClaudeAccount {
  email: string | null;
  orgName: string | null;
}

export interface RunOptions {
  signal: AbortSignal;
  /** A write is never retried and any deviation from the plan fails the run. */
  write?: boolean;
}

export interface ClaudeConnectorRunner {
  /** The claude.ai account Claude Code is signed in with, or an unauthorized RemoteError. */
  account(signal: AbortSignal): Promise<ClaudeAccount>;
  /** Make the planned calls through one connector. Missing outcomes mean the call did not run. */
  run(server: string, calls: PlannedCall[], opts: RunOptions): Promise<Map<string, CallOutcome>>;
}

const MAX_CONCURRENT = 2;
/** claude.ai connectors connect asynchronously; a session that met one still "pending" is started again. */
const PENDING_ATTEMPTS = 4;
const PENDING_DELAY_MS = 2_500;
const SESSION_BASE_MS = 60_000;
const SESSION_PER_CALL_MS = 8_000;
const SESSION_MAX_MS = 240_000;

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(platformLocations().home, ".claude");
}

function allowRules(file: string): unknown[] {
  if (!existsSync(file)) return [];
  try {
    const allow = (JSON.parse(readFileSync(file, "utf8")) as { permissions?: { allow?: unknown } }).permissions?.allow;
    return Array.isArray(allow) ? allow : [];
  } catch {
    return [];
  }
}

function userAllowRules(): unknown[] {
  return [...allowRules(join(claudeConfigDir(), "settings.json")), ...allowRules(process.env.JARVIS_MANAGED_SETTINGS ?? platformLocations().claudeManagedSettings)];
}

/** Claude Code's project directory name for a working directory: every non-alphanumeric character becomes "-". */
export function projectSlug(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Claude Code saves an oversized tool result to a file and hands the model a
 * pointer instead:
 *   <persisted-output>\nOutput too large (79.4KB). Full output saved to: /…/tool-results/toolu_….txt …
 * Only that exact wrapper is followed, and only to a file inside the project
 * directory of Jarvis's own connector session, so a path written into a Slack
 * message or an email is never read. The file holds connector data, so it is
 * deleted once read.
 */
export function resolveSpill(text: string, configDir = claudeConfigDir(), cwd = CONNECTOR_CWD): string {
  if (!text.trimStart().startsWith("<persisted-output>")) return text;
  // An absolute path on this line, POSIX or Windows (`C:\…`), which may contain spaces.
  const m = /Full output saved to: ((?:\/|[A-Za-z]:[\\/]).*?[\\/]tool-results[\\/][A-Za-z0-9._-]+\.(?:txt|json))\s/.exec(text);
  if (!m || m[1]!.split(/[\\/]/).includes("..")) return text;
  try {
    const root = realpathSync(join(configDir, "projects", projectSlug(realpathSync(cwd))));
    const file = realpathSync(m[1]!);
    if (!file.startsWith(root + sep)) return text;
    const content = readFileSync(file, "utf8");
    rmSync(file, { force: true });
    return content;
  } catch {
    return text;
  }
}

function serverError(label: string, server: { status: string; source: string | null } | null): RemoteError | null {
  if (!server) return new RemoteError(`The ${label} connector is not available to your claude.ai account. Add it in claude.ai → Settings → Connectors (a workspace admin may have to enable it for your organization).`, "not_configured");
  if (server.source !== "claudeai") return new RemoteError(`The server named like the ${label} connector comes from ${server.source ?? "an unknown source"}, not claude.ai; Jarvis only uses the claude.ai connector.`, "denied");
  if (server.status === "needs-auth") return new RemoteError(`${label} is not connected in claude.ai. Open claude.ai → Settings → Connectors, connect ${label}, then test again.`, "unauthorized");
  if (server.status !== "connected") return new RemoteError(`The ${label} connector is ${server.status} in Claude Code. Try again shortly.`, "offline");
  return null;
}

export function labelOf(server: string): string {
  return server.replace(/^claude\.ai\s+/, "");
}

export function createClaudeConnectorRunner(log: Logger, config: { pendingDelayMs?: number; sessionBaseMs?: number; sessionPerCallMs?: number } = {}): ClaudeConnectorRunner {
  const pendingDelayMs = config.pendingDelayMs ?? PENDING_DELAY_MS;
  // The time a session's calls get, counted from Claude Code's init: starting has a budget of its own (`runSession`).
  const sessionMs = (n: number) => Math.min(SESSION_MAX_MS, (config.sessionBaseMs ?? SESSION_BASE_MS) + n * (config.sessionPerCallMs ?? SESSION_PER_CALL_MS));
  let active = 0;
  const waiting: Array<() => void> = [];
  const knownServers = new Set<string>();
  let discovery: Promise<void> | null = null;

  /**
   * Learn every MCP server the user's Claude Code loads (their own and all claude.ai connectors), so a
   * connector session can hide the others: with tool search off their definitions would otherwise be
   * inlined and can exceed the model's context. All MCP tools are disallowed and the session stops at
   * init, so discovery makes no tool call and asks the model nothing.
   */
  const discover = (server: string, signal: AbortSignal): Promise<void> =>
    (discovery ??= runSession({ server, calls: [], hideServers: ["mcp__*"], signal, timeoutMs: sessionMs(0) })
      .then((out) => {
        for (const s of [out.server?.name, ...out.otherServers]) if (s) knownServers.add(s);
      })
      .catch((e: unknown) => log.warn("claude connector: could not list Claude Code's MCP servers", { error: (e as Error).message }))
      .finally(() => (discovery = null)));
  const acquire = async () => {
    if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
    active++;
  };
  const release = () => {
    active--;
    waiting.shift()?.();
  };

  async function once(server: string, calls: PlannedCall[], run: RunOptions) {
    const label = labelOf(server);
    const rules = preApprovingRules(userAllowRules(), server);
    if (rules.length) {
      throw new RemoteError(`Your Claude Code settings auto-approve ${label} tools (${rules.join(", ")}). Jarvis must approve each connector call itself; remove that rule from ${join(claudeConfigDir(), "settings.json")} and test again.`, "denied");
    }
    if (!knownServers.size) await discover(server, run.signal);
    const hidden = () => [...knownServers].filter((s) => s !== server).map(serverPrefix);
    await acquire();
    try {
      const session = () => runSession({ server, calls, hideServers: hidden(), signal: run.signal, timeoutMs: sessionMs(calls.length) });
      let out: Awaited<ReturnType<typeof runSession>>;
      try {
        out = await session();
      } catch (e) {
        // The context overflows at the first request, before any tool call, so starting again is safe even for a write.
        if (!(e instanceof PromptTooLongError) || run.signal.aborted) throw e;
        log.warn("claude connector session too large; listing MCP servers again", { server });
        await discover(server, run.signal);
        out = await session();
      }
      // A session that met a pending connector stopped at init, before any call, so starting again is safe even for a write.
      for (let attempt = 1; out.server?.status === "pending" && attempt < PENDING_ATTEMPTS && !run.signal.aborted; attempt++) {
        await new Promise((r) => setTimeout(r, pendingDelayMs));
        out = await session();
      }
      for (const s of [out.server?.name, ...out.otherServers]) if (s) knownServers.add(s);
      log.info("claude connector session", { server, calls: calls.length, answered: out.outcomes.size, violations: out.violations.length, costUsd: out.costUsd });
      const err = serverError(label, out.server);
      if (err) throw err;
      if (out.bypassed.length) {
        log.error("claude connector: a call ran without Jarvis's approval", { server, bypassed: out.bypassed });
        throw new RemoteError(`${label} ran ${out.bypassed.join(", ")} without asking Jarvis. A permission rule or hook outside Jarvis (user, managed or enterprise Claude Code settings) pre-approves it; remove that rule, then test again. The session was stopped and its results were discarded.`, "denied");
      }
      if (out.violations.length && run.write) throw new RemoteError(`The ${label} session attempted calls outside the approved action (${out.violations.join("; ")}). Nothing beyond the approved call was allowed.`, "error");
      if (out.violations.length) log.warn("claude connector: denied unplanned calls", { server, violations: out.violations });
      return out.outcomes;
    } finally {
      release();
    }
  }

  return {
    async account(signal) {
      const bin = findClaudeCli();
      if (!bin) throw new RemoteError("Claude Code is not installed on this computer. Install it from claude.com/claude-code and sign in with your claude.ai account.", "not_configured");
      const args = ["auth", "status", "--json"];
      // runTool reports a CLI Jarvis cannot start as a failed run; claudeLaunch names it not_configured first.
      claudeLaunch(bin, args);
      const result = await runTool(bin, args, { signal, timeoutMs: 20_000, env: { ...process.env, CLAUDE_INVOKED_BY: "jarvis" } });
      const stdout = result.stdout;
      if (result.code !== 0) {
        const text = stdout || result.stderr;
        if (/"loggedIn"\s*:\s*false/.test(text) || /not logged in/i.test(text)) throw new RemoteError("Claude Code is not signed in. Run `claude` once and sign in with your claude.ai account.", "unauthorized");
        throw new RemoteError(`Could not read the Claude Code sign-in: ${text.slice(0, 200)}`, "error");
      }
      let status: { loggedIn?: boolean; authMethod?: string; email?: string; orgName?: string };
      try {
        status = JSON.parse(stdout);
      } catch {
        throw new RemoteError("Claude Code returned an unreadable sign-in status", "error");
      }
      if (!status.loggedIn) throw new RemoteError("Claude Code is not signed in. Run `claude` once and sign in with your claude.ai account.", "unauthorized");
      if (status.authMethod && status.authMethod !== "claude.ai") throw new RemoteError(`Claude Code is signed in with ${status.authMethod}, which has no claude.ai connectors. Sign in with your claude.ai account instead.`, "unauthorized");
      return { email: status.email ?? null, orgName: status.orgName ?? null };
    },

    async run(server, calls, opts) {
      if (!calls.length) return new Map();
      let outcomes: Map<string, CallOutcome>;
      try {
        outcomes = await once(server, calls, opts);
      } catch (e) {
        // A read session that stalled is started once more; a write is never repeated.
        const stalled = e instanceof RemoteError && e.state === "offline" && /did not finish/.test(e.message);
        if (opts.write || !stalled || opts.signal.aborted) throw e;
        log.warn("claude connector session stalled; retrying the reads once", { server, calls: calls.length });
        outcomes = await once(server, calls, opts);
      }
      if (opts.write) return new Map([...outcomes].map(([k, v]) => [k, { ...v, text: resolveSpill(v.text) }]));
      // Reads the model skipped get one more session; anything still missing is reported by the caller.
      const missing = calls.filter((c) => !outcomes.has(c.id));
      if (missing.length && !opts.signal.aborted) {
        try {
          for (const [k, v] of await once(server, missing, opts)) outcomes.set(k, v);
        } catch (e) {
          log.warn("claude connector retry failed", { server, error: (e as Error).message });
        }
      }
      return new Map([...outcomes].map(([k, v]) => [k, { ...v, text: resolveSpill(v.text) }]));
    },
  };
}
