/**
 * Slack through the user's claude.ai Slack connector (see claude-adapter.ts).
 * Direct messages and mentions come from connector search, sorted newest
 * first inside the 48-hour window; watched channels from channel history.
 * The search tool rejects a query with neither keywords nor filters
 * (parameter_validation_failed), so the DM search filters on is:dm.
 * Posting is slack_send_message, read back from the channel or thread.
 */
import type { ConnectorAdapter, AdapterContext, Observation, RefreshResult, ExecuteResult } from "./types.ts";
import { CoverageTracker } from "./types.ts";
import { RemoteError, afterWrite } from "./http.ts";
import { attemptStartMs, csvList, recordFailure, stringSetting } from "./common.ts";
import { CLAUDE_SERVERS, callOne, claudeAuthMethods, claudeDataNote, claudeSetupSteps, configureClaude, paginateStreams, serverName, streamOrThrow, testClaude, type Stream, type StreamResult } from "./claude-adapter.ts";
import { parseHistory, parseProfile, parseSearch, sameText, sentTs, type SlackItem } from "./slack-format.ts";

const WINDOW_MS = 48 * 3_600_000;
const RECOVERY_WINDOW_MS = 7 * 86_400_000;
/** DMs include my own messages (needed to tell who owes a reply), so a busy 48 hours needs more pages. */
const MAX_DM_PAGES = 10;
const MAX_MENTION_PAGES = 5;
const SEARCH_PAGE = 20;
const CHANNEL_ID = /^[CGD][A-Z0-9]{2,}$/;
const USER_ID = /^[UW][A-Z0-9]{2,}$/;
const TS = /^\d+\.\d+$/;

const LABELS = { dms: "Direct messages (48 hours)", mentions: "Mentions of me (48 hours)", channels: "Watched channels (48 hours)" } as const;

const server = (ctx: AdapterContext) => serverName(ctx, CLAUDE_SERVERS.slack);
const windowStartS = (ctx: AdapterContext) => Math.floor((ctx.now().getTime() - WINDOW_MS) / 1000);

function searchStream(ctx: AdapterContext, id: string, label: string, maxPages: number, args: Record<string, unknown>): Stream<SlackItem> {
  const since = windowStartS(ctx);
  return {
    id,
    label,
    maxPages,
    call: (cursor) => ({ tool: "slack_search_public_and_private", args: { ...args, after: String(since), sort: "timestamp", sort_dir: "desc", limit: SEARCH_PAGE, include_context: false, response_format: "detailed", natural_language_query: "", ...(cursor ? { cursor } : {}) } }),
    parse: (text) => {
      const p = parseSearch(text);
      const inWindow = p.items.filter((m) => Number(m.ts) >= since);
      // Sorted newest first: once a page reaches before the window, later pages cannot be newer.
      const reachedEnd = inWindow.length < p.items.length;
      return { items: inWindow, next: reachedEnd ? null : p.cursor, unreadable: p.unreadable };
    },
  };
}

function channelStream(ctx: AdapterContext, channel: string): Stream<SlackItem> {
  return {
    id: `channel:${channel}`,
    label: channel,
    maxPages: 1,
    call: () => ({ tool: "slack_read_channel", args: { channel_id: channel, oldest: String(windowStartS(ctx)), limit: 100, response_format: "detailed" } }),
    parse: (text) => {
      const p = parseHistory(text, channel);
      return { items: p.items, next: p.cursor, unreadable: p.unreadable };
    },
  };
}

const isHuman = (m: SlackItem) => !m.bot && !!m.user;

function messageUrl(m: SlackItem, teamUrl: string | null): string | undefined {
  if (m.permalink) return m.permalink;
  if (!teamUrl) return undefined;
  return `${teamUrl.replace(/\/$/, "")}/archives/${m.channel}/p${m.ts.replace(".", "")}`;
}

function observation(p: { msg: SlackItem; kind: string; awaiting: boolean; attentionKind: string | null; why: string; teamUrl: string | null }): Observation {
  const { msg } = p;
  const url = messageUrl(msg, p.teamUrl);
  const text = msg.text.slice(0, 4000);
  const threadTs = msg.threadTs ?? (p.kind === "slack_dm" ? undefined : msg.ts);
  const who = msg.userName ?? msg.user ?? "someone";
  return {
    kind: p.kind,
    externalId: `${msg.channel}:${msg.ts}`,
    title: text.split("\n")[0]!.slice(0, 120) || "(message)",
    ...(url ? { url } : {}),
    ...(msg.user ? { author: msg.userName ?? msg.user } : {}),
    occurredAt: new Date(Number(msg.ts) * 1000).toISOString(),
    data: { channel: msg.channel, channelName: msg.channelName, ts: msg.ts, threadTs: msg.threadTs, user: msg.user, userName: msg.userName, text, awaiting: p.awaiting },
    fingerprintParts: [text, p.awaiting],
    ...(p.attentionKind && p.awaiting
      ? {
          attention: {
            key: `slack:${msg.channel}:${msg.ts}`,
            kind: p.attentionKind,
            title: p.attentionKind === "pending_reply" ? `Reply to ${who} in Slack` : `Mentioned in ${msg.channelName ? `#${msg.channelName}` : "Slack"}`,
            summary: text.slice(0, 280),
            why: p.why,
            ...(url ? { url } : {}),
            priority: p.attentionKind === "pending_reply" ? 65 : 55,
            draftable: { actionKind: "slack.post", target: { channel: msg.channel, ...(threadTs ? { thread_ts: threadTs } : {}) }, context: { text, user: msg.user, userName: msg.userName } },
          },
        }
      : {}),
  };
}

function noteFor(r: StreamResult<SlackItem>, extra: string[] = []): string | undefined {
  const parts = [...(r.error ? [r.error.message] : !r.complete ? [`Stopped after ${r.pages} pages`] : []), ...(r.unreadable ? [`${r.unreadable} result(s) could not be read`] : []), ...extra];
  return parts.length ? parts.join("; ") : undefined;
}

function stateOf(r: StreamResult<SlackItem>, items: number) {
  if (!r.complete || r.unreadable) return "partial" as const;
  return items ? ("complete" as const) : ("empty" as const);
}

async function selfId(ctx: AdapterContext): Promise<string> {
  const cached = stringSetting(ctx.connection.settings, "userId");
  if (USER_ID.test(cached)) return cached;
  const p = parseProfile(await callOne(ctx, server(ctx), "slack_read_user_profile", { response_format: "detailed" }));
  if (!p.userId) throw new RemoteError("The Slack connector did not report your user id", "error");
  return p.userId;
}

/** Workspace URL (for links to messages read from history, which carry no permalink), taken from any search permalink. */
export function teamUrlFrom(results: Map<string, StreamResult<SlackItem>>): string | null {
  for (const r of results.values()) {
    const link = r.items.find((m) => m.permalink)?.permalink;
    if (link) {
      try {
        return new URL(link).origin;
      } catch {
        // ignore a malformed permalink
      }
    }
  }
  return null;
}

function syncResults(ctx: AdapterContext, self: string, results: Map<string, StreamResult<SlackItem>>, requested: string[], cov: CoverageTracker, out: Observation[]) {
  const teamUrl = teamUrlFrom(results);
  const scopes = ctx.connection.readScopes;
  if (scopes.includes("dms")) {
    try {
      const r = streamOrThrow(results.get("dms"));
      const latest = new Map<string, SlackItem>();
      for (const m of r.items.filter((x) => isHuman(x) && x.isDm)) if (!latest.has(m.channel)) latest.set(m.channel, m);
      for (const m of latest.values()) out.push(observation({ msg: m, kind: "slack_dm", awaiting: m.user !== self, attentionKind: "pending_reply", why: "The latest message in this direct conversation is from someone else.", teamUrl }));
      // Hits that none of the readers recognise mean the connector's format changed, not that nothing happened.
      const drift = r.items.length > 0 && !r.items.some((x) => x.isDm) ? ["Search returned messages but none were recognised as direct messages"] : [];
      cov.add(LABELS.dms, drift.length ? "partial" : stateOf(r, latest.size), latest.size, r.pages, noteFor(r, drift));
    } catch (e) {
      recordFailure(cov, LABELS.dms, e);
    }
  }
  if (scopes.includes("mentions")) {
    try {
      const r = streamOrThrow(results.get("mentions"));
      const mine = r.items.filter((m) => isHuman(m) && m.user !== self && m.text.includes(`<@${self}`));
      for (const m of mine) out.push(observation({ msg: m, kind: "slack_mention", awaiting: true, attentionKind: "mention", why: "Someone @mentioned you in Slack in the last 48 hours.", teamUrl }));
      // Search matched on my user id; if no hit shows it, the mention format changed and the count is not trustworthy.
      const drift = r.items.length > 0 && !r.items.some((m) => m.text.includes(`<@${self}`)) ? ["Search returned messages but none showed the mention in a recognised form"] : [];
      cov.add(LABELS.mentions, drift.length ? "partial" : stateOf(r, mine.length), mine.length, r.pages, noteFor(r, drift));
    } catch (e) {
      recordFailure(cov, LABELS.mentions, e);
    }
  }
  if (scopes.includes("channels")) {
    if (!requested.length) {
      cov.add(LABELS.channels, "not_configured", 0, 0, "No channels configured to watch");
      return;
    }
    const missing: string[] = [];
    let items = 0;
    let pages = 0;
    let partial = false;
    for (const channel of requested) {
      const r = results.get(`channel:${channel}`);
      if (!r || (r.error && r.pages === 0)) {
        missing.push(`${channel} (${r?.error?.message ?? "not read"})`);
        continue;
      }
      pages += r.pages;
      if (!r.complete || r.unreadable) partial = true;
      for (const m of r.items.filter(isHuman)) {
        items++;
        out.push(observation({ msg: m, kind: "slack_channel_message", awaiting: false, attentionKind: null, why: "", teamUrl }));
      }
    }
    const notes = [...(missing.length ? [`Not read: ${missing.join(", ")}`] : []), ...(partial ? ["Some channels had more messages than one page, or unreadable messages"] : [])];
    const state = missing.length === requested.length ? "error" : missing.length || partial ? "partial" : items ? "complete" : "empty";
    cov.add(LABELS.channels, state, items, pages, notes.length ? notes.join("; ") : undefined);
  }
}

function postTarget(target: Record<string, unknown>): { channel: string; threadTs: string | null } {
  const channel = String(target.channel ?? "");
  const threadTs = target.thread_ts ? String(target.thread_ts) : null;
  if (!CHANNEL_ID.test(channel)) throw new RemoteError("Invalid Slack channel", "error");
  if (threadTs && !TS.test(threadTs)) throw new RemoteError("Invalid Slack thread", "error");
  return { channel, threadTs };
}

async function readRecent(ctx: AdapterContext, channel: string, threadTs: string | null, oldestS: number): Promise<SlackItem[]> {
  const text = threadTs
    ? await callOne(ctx, server(ctx), "slack_read_thread", { channel_id: channel, message_ts: threadTs, oldest: String(oldestS), limit: 200, response_format: "detailed" })
    : await callOne(ctx, server(ctx), "slack_read_channel", { channel_id: channel, oldest: String(oldestS), limit: 100, response_format: "detailed" });
  const p = parseHistory(text, channel);
  if (p.cursor) throw new RemoteError("More recent messages than one page; could not check them all", "partial");
  return p.items;
}

export const slackAdapter: ConnectorAdapter = {
  kind: "slack",
  secretNames: [],
  definition: {
    kind: "slack",
    label: "Slack",
    description: "Direct messages waiting for your reply, @mentions, and optionally chosen channels.",
    authMethods: claudeAuthMethods(CLAUDE_SERVERS.slack, [{ id: "channels", label: "Channels to watch", secret: false, optional: true, placeholder: "C0123ABCD, C0456EFGH", help: "Comma-separated channel IDs (from the channel's About panel)." }]),
    scopes: [
      { id: "dms", label: "Direct messages awaiting my reply", default: true },
      { id: "mentions", label: "Messages that @mention me", default: true },
      { id: "channels", label: "Watched channels", default: false },
    ],
    writeActions: [{ id: "slack.post", label: "Post a message or thread reply" }],
    setupHelp: `${claudeDataNote(CLAUDE_SERVERS.slack)} Messages are only posted after you approve each draft.`,
    unavoidableSteps: claudeSetupSteps(CLAUDE_SERVERS.slack),
  },

  async configure(_ctx, fields) {
    const channels = csvList(fields.channels ?? "");
    const bad = channels.filter((c) => !CHANNEL_ID.test(c));
    if (bad.length) throw new RemoteError(`Not a channel ID: ${bad.join(", ")}`, "not_configured");
    return configureClaude(fields, CLAUDE_SERVERS.slack, { channels: channels.join(",") });
  },

  async test(ctx) {
    return testClaude(ctx, server(ctx), { tool: "slack_read_user_profile", args: { response_format: "detailed" } }, (text) => {
      const p = parseProfile(text);
      if (!p.userId) throw new RemoteError("The Slack connector did not report your user id", "error");
      return { account: p.email ?? p.name ?? p.userId, settings: { userId: p.userId } };
    });
  },

  async refresh(ctx): Promise<RefreshResult> {
    const cov = new CoverageTracker();
    const observations: Observation[] = [];
    const scopes = ctx.connection.readScopes;
    if (!scopes.some((s) => s in LABELS)) return { coverage: cov.finish(), observations };
    let self: string;
    try {
      self = await selfId(ctx);
    } catch (e) {
      for (const s of scopes.filter((x): x is keyof typeof LABELS => x in LABELS)) recordFailure(cov, LABELS[s], e);
      return { coverage: cov.finish(), observations };
    }
    const requested = csvList(stringSetting(ctx.connection.settings, "channels")).filter((c) => CHANNEL_ID.test(c));
    const streams: Array<Stream<SlackItem>> = [
      ...(scopes.includes("dms") ? [searchStream(ctx, "dms", LABELS.dms, MAX_DM_PAGES, { filters: "is:dm", channel_types: "im", include_bots: false })] : []),
      ...(scopes.includes("mentions") ? [searchStream(ctx, "mentions", LABELS.mentions, MAX_MENTION_PAGES, { keywords: [`<@${self}>`], channel_types: "public_channel,private_channel,mpim,im", include_bots: false })] : []),
      ...(scopes.includes("channels") ? requested.map((c) => channelStream(ctx, c)) : []),
    ];
    const results = await paginateStreams(ctx, server(ctx), streams);
    syncResults(ctx, self, results, requested, cov, observations);
    // A DM that @mentions me appears in both scopes; the first (DM) reading wins.
    const seen = new Set<string>();
    const unique = observations.filter((o) => !seen.has(o.externalId) && !!seen.add(o.externalId));
    return { coverage: cov.finish(), observations: unique };
  },

  async execute(ctx, action): Promise<ExecuteResult> {
    if (action.kind !== "slack.post") throw new RemoteError(`Unsupported action ${action.kind}`, "error");
    const { channel, threadTs } = postTarget(action.target);
    const text = String(action.payload.text ?? action.payload.body ?? "").trim();
    if (!text) throw new RemoteError("The message is empty", "error");
    const raw = await callOne(ctx, server(ctx), "slack_send_message", { channel_id: channel, message: text, ...(threadTs ? { thread_ts: threadTs } : {}) }, { write: true });
    const sent = sentTs(raw);
    if (!sent.ts) return { verified: false, detail: { channel, threadTs, note: "Slack did not report the message timestamp", response: raw.slice(0, 300) } };
    const self = await afterWrite(() => selfId(ctx));
    const recent = await afterWrite(() => readRecent(ctx, channel, threadTs, Math.floor(Number(sent.ts)) - 1));
    const verified = !!recent?.some((m) => m.ts === sent.ts && (!self || m.user === self));
    return { verified, remoteId: sent.ts, ...(sent.permalink ? { url: sent.permalink } : {}), detail: { channel, ts: sent.ts, threadTs } };
  },

  async findEffect(ctx, action) {
    const { channel, threadTs } = postTarget(action.target);
    const text = String(action.payload.text ?? action.payload.body ?? "");
    const self = await selfId(ctx);
    const fromMs = attemptStartMs(action.since, ctx.now().getTime() - RECOVERY_WINDOW_MS);
    const recent = await readRecent(ctx, channel, threadTs, Math.floor(fromMs / 1000));
    // The connector cannot attach message metadata, so an earlier attempt is recognised by author, time and text.
    const found = recent.find((m) => m.user === self && Number(m.ts) * 1000 >= fromMs && sameText(m.text, text));
    return found ? { verified: true, remoteId: found.ts, detail: { channel, ts: found.ts, threadTs, recovered: true, matchedBy: "author and text" } } : null;
  },
};
