/**
 * Shared plumbing for adapters that read and write through the user's
 * claude.ai connectors (Slack, Gmail, Google Calendar) via Claude Code.
 * Authorization lives in claude.ai: Jarvis stores no credential for these
 * connections and only needs Claude Code signed in on this computer.
 */
import type { ConnectionDefinition, CoverageState } from "@jarvis/contracts";
import type { AdapterContext, TestResult } from "./types.ts";
import { RemoteError } from "./http.ts";
import { asRemoteError, stringSetting } from "./common.ts";
import { findClaudeCli } from "../models/providers.ts";
import { labelOf } from "./claude/runner.ts";
import type { CallOutcome, PlannedCall } from "./claude/plan.ts";

export const CLAUDE_AUTH_METHOD = "claude-ai";

export const CLAUDE_SERVERS = {
  slack: "claude.ai Slack",
  gmail: "claude.ai Gmail",
  gcal: "claude.ai Google Calendar",
} as const;

type Field = ConnectionDefinition["authMethods"][number]["fields"][number];

const SERVER_FIELD = (name: string): Field => ({ id: "server", label: "Connector name in Claude Code", secret: false, optional: true, placeholder: name, help: `Only change this if your organization named the claude.ai connector differently (see \`claude mcp list\`).` });

export function claudeAuthMethods(server: string, extraFields: Field[] = []): ConnectionDefinition["authMethods"] {
  const label = labelOf(server);
  return [
    {
      id: CLAUDE_AUTH_METHOD,
      label: `Your claude.ai ${label} connector, through Claude Code on this computer`,
      reconnectHelp: `Make sure Claude Code is signed in on this computer (run \`claude\` once in a terminal) and that ${label} shows as connected in claude.ai → Settings → Connectors, then reconnect.`,
      fields: [...extraFields, SERVER_FIELD(server)],
    },
  ];
}

export function claudeSetupSteps(server: string): string[] {
  const label = labelOf(server);
  return [
    "Install Claude Code on this computer (claude.com/claude-code) and sign in once with your claude.ai work account.",
    `In claude.ai → Settings → Connectors, connect ${label} with the same account. In a claude.ai Team or Enterprise workspace an admin may have to enable the ${label} connector first.`,
  ];
}

export function claudeDataNote(server: string): string {
  return `Jarvis reaches ${labelOf(server)} through your own claude.ai connector: a local Claude Code session makes only the calls Jarvis approves, and the results pass through Anthropic as they do when you use the connector in Claude.`;
}

export function serverName(ctx: AdapterContext, fallback: string): string {
  return stringSetting(ctx.connection.settings, "server") || fallback;
}

export function configureClaude(fields: Record<string, string>, fallback: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  if (!findClaudeCli()) throw new RemoteError("Claude Code is not installed on this computer. Install it from claude.com/claude-code and sign in with your claude.ai account, then connect again.", "not_configured");
  const server = fields.server?.trim() ?? "";
  if (server && !/^claude\.ai [\w .&()-]{1,80}$/.test(server)) throw new RemoteError('The connector name must look like "claude.ai Slack"', "not_configured");
  return { authMethod: CLAUDE_AUTH_METHOD, ...(server && server !== fallback ? { server } : {}), ...extra };
}

/** Coverage state for an error a connector tool reported in its result text. */
export function connectorErrorState(text: string): CoverageState {
  if (/invalid_auth|not_authed|token_revoked|token_expired|account_inactive|unauthenticated|401|reconnect|re-?authori[sz]e/i.test(text)) return "unauthorized";
  if (/missing_scope|not_allowed_token_type|no_permission|permission|forbidden|403|insufficient/i.test(text)) return "denied";
  if (/rate.?limit|ratelimited|429|quota/i.test(text)) return "partial";
  if (/timeout|timed out|unavailable|50\d/i.test(text)) return "offline";
  return "error";
}

export function toolError(label: string, tool: string, text: string): RemoteError {
  return new RemoteError(`${label} ${tool} failed: ${text.slice(0, 300) || "unknown error"}`, connectorErrorState(text));
}

/** The text of one planned call's outcome, or a classified error when it failed or never ran. */
export function outcomeText(outcomes: Map<string, CallOutcome>, call: PlannedCall, label: string): string {
  const o = outcomes.get(call.id);
  if (!o) throw new RemoteError(`${label} ${call.tool} did not run in the Claude Code session`, "error");
  if (o.status === "tool_error") throw toolError(label, call.tool, o.text);
  return o.text;
}

export async function callOne(ctx: AdapterContext, server: string, tool: string, args: Record<string, unknown>, opts: { write?: boolean } = {}): Promise<string> {
  const call = { id: "1", tool, args };
  const outcomes = await ctx.claude.run(server, [call], { signal: ctx.signal, ...(opts.write ? { write: true } : {}) });
  return outcomeText(outcomes, call, labelOf(server));
}

export interface Stream<T> {
  id: string;
  label: string;
  maxPages: number;
  call(cursor: string | null): { tool: string; args: Record<string, unknown> };
  parse(text: string): { items: T[]; next: string | null; unreadable?: number };
}

export interface StreamResult<T> {
  items: T[];
  pages: number;
  complete: boolean;
  unreadable: number;
  error: RemoteError | null;
}

/**
 * Page several independent listings together: every round makes the next
 * page of each unfinished listing in one Claude Code session. A failure on
 * a first page is that listing's failure; a later failure leaves it partial.
 */
export async function paginateStreams<T>(ctx: AdapterContext, server: string, streams: Array<Stream<T>>): Promise<Map<string, StreamResult<T>>> {
  const label = labelOf(server);
  const state = new Map<string, StreamResult<T> & { cursor: string | null; done: boolean }>(streams.map((s) => [s.id, { items: [], pages: 0, complete: false, unreadable: 0, error: null, cursor: null, done: false }]));
  for (let round = 0; ; round++) {
    const active = streams.filter((s) => !state.get(s.id)!.done);
    if (!active.length) break;
    const calls = active.map((s) => ({ id: `${s.id}#${round}`, ...s.call(state.get(s.id)!.cursor) }));
    let outcomes: Map<string, CallOutcome>;
    try {
      outcomes = await ctx.claude.run(server, calls, { signal: ctx.signal });
    } catch (e) {
      for (const s of active) Object.assign(state.get(s.id)!, { error: asRemoteError(e), done: true });
      break;
    }
    active.forEach((s, i) => {
      const st = state.get(s.id)!;
      try {
        const page = s.parse(outcomeText(outcomes, calls[i]!, label));
        st.items.push(...page.items);
        st.unreadable += page.unreadable ?? 0;
        st.pages++;
        if (!page.next) Object.assign(st, { complete: true, done: true });
        else if (st.pages >= s.maxPages) st.done = true;
        else st.cursor = page.next;
      } catch (e) {
        Object.assign(st, { error: asRemoteError(e), done: true });
      }
    });
  }
  return new Map([...state].map(([k, { cursor: _c, done: _d, ...rest }]) => [k, rest]));
}

/** A first-page failure throws (the scope failed); later failures are reported as partial by the caller. */
export function streamOrThrow<T>(r: StreamResult<T> | undefined): StreamResult<T> {
  if (!r) throw new RemoteError("The listing did not run", "error");
  if (r.error && r.pages === 0) throw r.error;
  return r;
}

/** Test a claude.ai connection: Claude Code is signed in, the connector answers one real read. */
export async function testClaude(ctx: AdapterContext, server: string, probe: { tool: string; args: Record<string, unknown> }, describe: (text: string) => { account: string | null; settings?: Record<string, unknown> }): Promise<TestResult> {
  try {
    const who = await ctx.claude.account(ctx.signal);
    const text = await callOne(ctx, server, probe.tool, probe.args);
    const d = describe(text);
    const account = d.account ?? who.email;
    return { ok: true, state: "complete", account, message: `${labelOf(server)} answered through claude.ai${who.email ? ` (${who.email}${who.orgName ? `, ${who.orgName}` : ""})` : ""}`, ...(d.settings ? { settings: d.settings } : {}) };
  } catch (e) {
    const err = asRemoteError(e);
    return { ok: false, state: err.state, account: null, message: err.message };
  }
}
