/**
 * TEST-ONLY: the fixture side of fake-claude.mjs. Tests choose which claude.ai
 * connectors exist and their status, whether Claude Code is signed in, how
 * "the model" behaves, and how each connector tool answers. Slack answers are
 * rendered in the connector's real text format (see slack-format.ts).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FixtureServer } from "./fixture-server.ts";

export type ToolAnswer = { text: string; isError?: boolean };
export type ToolHandler = (args: Record<string, unknown>) => ToolAnswer | Promise<ToolAnswer>;

export interface ClaudeFixture {
  servers: Array<{ name: string; status: string; source: string }>;
  auth: { loggedIn: boolean; authMethod?: string; email?: string; orgName?: string };
  mode: "normal" | "unplanned" | "altered" | "skip-last" | "skip-all" | "not-logged-in" | "hang" | "slow-start" | "preapproved" | "too-long-unless-hidden";
  /** Every session the fixture CLI started: the tools it was told to disallow and how many calls were planned. */
  started: Array<{ disallowed: string[]; planned: number }>;
  /** Connector sessions started (one per Claude Code run). */
  sessions: number;
  /** Modes for the next sessions, consumed one per session before `mode` applies. */
  nextModes: ClaudeFixture["mode"][];
  tools: Map<string, ToolHandler>;
  calls: Array<{ server: string; tool: string; args: Record<string, unknown> }>;
}

/**
 * The fixture CLI as Claude Code is installed on this operating system: the
 * script itself, or on Windows an npm command shim around it, as `npm install
 * -g` creates.
 */
export const FAKE_CLAUDE = resolve(import.meta.dirname, process.platform === "win32" ? "fake-claude.cmd" : "fake-claude.mjs");

const key = (server: string, tool: string) => `${server}\0${tool}`;

/** Point the connector runner at the fixture CLI and an empty Claude config directory. */
export function useFakeClaude(fixtureUrl: string): void {
  process.env.ATTACHE_CLAUDE_BIN = FAKE_CLAUDE;
  process.env.ATTACHE_FAKE_CLAUDE_URL = fixtureUrl;
  process.env.CLAUDE_CONFIG_DIR ??= mkdtempSync(join(tmpdir(), "attache-claude-config-"));
}

export function mountClaude(fx: FixtureServer, init: Partial<Omit<ClaudeFixture, "tools" | "calls" | "sessions" | "nextModes" | "started">> = {}): ClaudeFixture {
  const f: ClaudeFixture = {
    servers: init.servers ?? ["claude.ai Slack", "claude.ai Gmail", "claude.ai Google Calendar"].map((name) => ({ name, status: "connected", source: "claudeai" })),
    auth: init.auth ?? { loggedIn: true, authMethod: "claude.ai", email: "alex@example.com", orgName: "Example Org" },
    mode: init.mode ?? "normal",
    tools: new Map(),
    calls: [],
    sessions: 0,
    nextModes: [],
    started: [],
  };
  fx.route("POST", "/claude/started", (req) => {
    f.started.push(req.body as ClaudeFixture["started"][number]);
    return { json: { ok: true } };
  });
  fx.route("GET", "/claude/auth", () => ({ json: f.auth }));
  fx.route("GET", "/claude/servers", () => ({ json: { servers: f.servers } }));
  fx.route("GET", "/claude/behavior", () => {
    f.sessions++;
    return { json: { mode: f.nextModes.shift() ?? f.mode } };
  });
  fx.route("POST", "/claude/call", async (req) => {
    const b = req.body as { server: string; tool: string; args: Record<string, unknown> };
    f.calls.push(b);
    const h = f.tools.get(key(b.server, b.tool));
    return { json: h ? await h(b.args) : { text: `Unknown tool ${b.tool}`, isError: true } };
  });
  return f;
}

export function onTool(f: ClaudeFixture, server: string, tool: string, h: ToolHandler): void {
  f.tools.set(key(server, tool), h);
}

export const jsonAnswer = (data: unknown): ToolAnswer => ({ text: JSON.stringify(data) });

/** The live Slack search tool refuses a query with neither keywords nor filters; fixtures must too. */
export function slackSearchInvalid(args: Record<string, unknown>): ToolAnswer | null {
  const keywords = Array.isArray(args.keywords) ? args.keywords : [];
  return keywords.length || (typeof args.filters === "string" && args.filters.trim()) ? null : { text: "execution_failed: parameter_validation_failed", isError: true };
}

// ---- Slack text rendering (mirrors the claude.ai Slack connector) --------------------------

export interface SlackFixtureMessage {
  channel: string;
  channelName?: string;
  user: string;
  userName?: string;
  bot?: boolean;
  ts: string;
  text: string;
  threadTs?: string;
}

const time = (ts: string) => new Date(Number(ts) * 1000).toISOString().replace("T", " ").slice(0, 19);

export function slackSearchAnswer(messages: SlackFixtureMessage[], cursor: string | null = null): ToolAnswer {
  const blocks = messages.map((m, i) => {
    const channel = m.channel.startsWith("D") ? `DM (ID: ${m.channel})` : `#${m.channelName ?? "general"} (ID: ${m.channel})`;
    const link = `https://acme.slack.com/archives/${m.channel}/p${m.ts.replace(".", "")}${m.threadTs ? `?thread_ts=${m.threadTs}&cid=${m.channel}` : ""}`;
    return `### Result ${i + 1} of ${messages.length}\nChannel: ${channel}\nFrom: ${m.userName ?? m.user} <${m.user.toLowerCase()}@example.com> (ID: ${m.user}) ${m.bot ? " [BOT]" : ""}\nTime: ${time(m.ts)} CEST\nMessage_ts: ${m.ts}\nPermalink: [link](${link})\nText: \n${m.text}\n\n---\n\n`;
  });
  return jsonAnswer({ results: `# Search Results for: \n\n## Messages (${messages.length} results)\n${blocks.join("")}`, ...(cursor ? { pagination_info: `For the next page of results use cursor \`${cursor}\`\n` } : {}) });
}

export function slackHistoryAnswer(channel: string, messages: SlackFixtureMessage[], cursor: string | null = null): ToolAnswer {
  const body = messages.map((m) => `=== Message from ${m.userName ?? m.user} <${m.user.toLowerCase()}@example.com> (${m.user}) at ${time(m.ts)} CEST === \nMessage TS: ${m.ts}\n${m.text}`).join("\n\n");
  return jsonAnswer({ messages: `Channel: ${channel.startsWith("D") ? "DM" : "#general"} (${channel})\n\n${body}`, ...(cursor ? { pagination_info: `There are more messages available. To view the next page, use cursor: \`${cursor}\`\n` } : {}) });
}

export function slackProfileAnswer(userId: string, email = "alex@example.com"): ToolAnswer {
  return jsonAnswer({ result: `User ID: ${userId}\nUsername: alex\nDisplay Name: alex\nReal Name: Alex Example\nEmail: ${email}\nTimezone: Europe/Copenhagen\n` });
}
