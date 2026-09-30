import type { CoverageState } from "@jarvis/contracts";
import type { ConnectorAdapter, AdapterContext, Observation, SyncResult, ExecuteResult } from "./types.ts";
import { CoverageTracker } from "./types.ts";
import { RemoteError, paginate } from "./http.ts";
import { asRemoteError, csvList, listingNote, listingState, recordFailure, stringSetting } from "./common.ts";

interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
  metadata?: { event_type?: string; event_payload?: { key?: unknown } };
}

interface SlackMatch {
  ts: string;
  text?: string;
  user?: string;
  username?: string;
  permalink?: string;
  channel?: { id?: string; name?: string; is_im?: boolean };
}

interface SlackIm {
  id: string;
  user?: string;
  is_user_deleted?: boolean;
  is_archived?: boolean;
}

interface Self {
  userId: string;
  teamUrl: string | null;
}

/** Query/body parameters; nested objects (e.g. metadata) are only valid in JSON POST bodies. */
type Params = Record<string, unknown>;

const DEFAULT_BASE = "https://slack.com/api";
const WINDOW_MS = 48 * 3_600_000;
const MAX_LIST_PAGES = 5;
const MAX_SEARCH_PAGES = 3;
const MAX_IMS = 100;
const EFFECT_EVENT = "jarvis_effect";
const CHANNEL_ID = /^[CGD][A-Z0-9]{2,}$/;
/** Messages that are not something a person said and can never be awaiting a reply. */
const NON_HUMAN_SUBTYPES = new Set(["bot_message", "channel_join", "channel_leave", "channel_topic", "channel_purpose", "channel_name", "tombstone", "message_deleted", "message_changed"]);

const ERROR_STATES: Record<string, CoverageState> = {
  invalid_auth: "unauthorized",
  not_authed: "unauthorized",
  token_revoked: "unauthorized",
  token_expired: "unauthorized",
  account_inactive: "unauthorized",
  missing_scope: "denied",
  not_allowed_token_type: "denied",
  no_permission: "denied",
  ratelimited: "partial",
  channel_not_found: "partial",
  not_in_channel: "partial",
};

/** Slack reports most failures as HTTP 200 with {ok:false,error}; the code is kept for per-channel handling. */
export class SlackError extends RemoteError {
  readonly code: string;
  constructor(method: string, code: string, needed?: string) {
    const state = ERROR_STATES[code] ?? "error";
    super(`Slack ${method} failed: ${code}${needed ? ` (needs ${needed})` : ""}`, state);
    this.code = code;
  }
}

const isChannelError = (e: unknown) => e instanceof SlackError && (e.code === "channel_not_found" || e.code === "not_in_channel");

function base(ctx: AdapterContext): string {
  return ctx.endpoint(DEFAULT_BASE).replace(/\/$/, "");
}

async function authHeader(ctx: AdapterContext): Promise<Record<string, string>> {
  const token = await ctx.secret("token");
  if (!token) throw new RemoteError("No Slack token stored", "unauthorized");
  return { authorization: `Bearer ${token}` };
}

function query(params: Params): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) qs.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  return qs.toString();
}

async function call<T>(ctx: AdapterContext, method: string, params: Params = {}, opts: { post?: boolean; retries?: number } = {}): Promise<T> {
  const headers = await authHeader(ctx);
  const res = opts.post
    ? await ctx.http.request<T & { ok: boolean; error?: string; needed?: string }>({ method: "POST", url: `${base(ctx)}/${method}`, headers, body: params, retries: opts.retries ?? 0 })
    : await ctx.http.request<T & { ok: boolean; error?: string; needed?: string }>({ url: `${base(ctx)}/${method}?${query(params)}`, headers });
  if (!res.data || typeof res.data !== "object") throw new RemoteError(`Slack ${method} returned an unexpected response`, "error");
  if (!res.data.ok) throw new SlackError(method, res.data.error ?? "unknown_error", res.data.needed);
  return res.data;
}

async function whoAmI(ctx: AdapterContext): Promise<Self & { user: string | null; team: string | null }> {
  const r = await call<{ user_id: string; user?: string; team?: string; url?: string }>(ctx, "auth.test", {}, { post: true, retries: 1 });
  return { userId: r.user_id, user: r.user ?? null, team: r.team ?? null, teamUrl: r.url ?? null };
}

const cursorOf = (r: { response_metadata?: { next_cursor?: string } }) => r.response_metadata?.next_cursor || null;
const windowStart = (ctx: AdapterContext) => (ctx.now().getTime() - WINDOW_MS) / 1000;
const isHuman = (m: SlackMessage) => !m.bot_id && !(m.subtype && NON_HUMAN_SUBTYPES.has(m.subtype)) && !!m.user;

function messageUrl(self: Self, channel: string, ts: string, permalink?: string): string | undefined {
  if (permalink) return permalink;
  if (!self.teamUrl) return undefined;
  return `${self.teamUrl.replace(/\/$/, "")}/archives/${channel}/p${ts.replace(".", "")}`;
}

function messageObservation(p: { self: Self; kind: string; channel: string; msg: { ts: string; text?: string; user?: string; thread_ts?: string }; awaiting: boolean; attentionKind: string | null; why: string; permalink?: string; channelName?: string }): Observation {
  const { self, channel, msg } = p;
  const url = messageUrl(self, channel, msg.ts, p.permalink);
  const text = (msg.text ?? "").slice(0, 4000);
  const occurredAt = new Date(Number(msg.ts) * 1000).toISOString();
  const threadTs = msg.thread_ts ?? (p.kind === "slack_dm" ? undefined : msg.ts);
  return {
    kind: p.kind,
    externalId: `${channel}:${msg.ts}`,
    title: text.split("\n")[0]!.slice(0, 120) || "(message)",
    ...(url ? { url } : {}),
    ...(msg.user ? { author: msg.user } : {}),
    occurredAt,
    data: { channel, channelName: p.channelName ?? null, ts: msg.ts, threadTs: msg.thread_ts ?? null, user: msg.user ?? null, text, awaiting: p.awaiting },
    fingerprintParts: [text, p.awaiting],
    ...(p.attentionKind && p.awaiting
      ? {
          attention: {
            key: `slack:${channel}:${msg.ts}`,
            kind: p.attentionKind,
            title: p.attentionKind === "pending_reply" ? `Reply to <@${msg.user}> in Slack` : `Mentioned in ${p.channelName ? `#${p.channelName}` : "Slack"}`,
            summary: text.slice(0, 280),
            why: p.why,
            ...(url ? { url } : {}),
            priority: p.attentionKind === "pending_reply" ? 65 : 55,
            draftable: { actionKind: "slack.post", target: { channel, ...(threadTs ? { thread_ts: threadTs } : {}) }, context: { text, user: msg.user ?? null } },
          },
        }
      : {}),
  };
}

async function listIms(ctx: AdapterContext) {
  return paginate<SlackIm>(
    async (cursor) => {
      const r = await call<{ channels?: SlackIm[]; response_metadata?: { next_cursor?: string } }>(ctx, "conversations.list", { types: "im", limit: 200, exclude_archived: true, cursor: cursor ?? undefined });
      return { items: r.channels ?? [], next: cursorOf(r) };
    },
    { maxPages: MAX_LIST_PAGES },
  );
}

async function recentHistory(ctx: AdapterContext, channel: string, limit: number) {
  return paginate<SlackMessage>(
    async (cursor) => {
      const r = await call<{ messages?: SlackMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>(ctx, "conversations.history", { channel, oldest: windowStart(ctx).toFixed(6), limit, cursor: cursor ?? undefined });
      return { items: r.messages ?? [], next: r.has_more ? cursorOf(r) : null };
    },
    { maxPages: 1 },
  );
}

async function syncDms(ctx: AdapterContext, self: Self, cov: CoverageTracker, out: Observation[]) {
  const label = "Direct messages (48 hours)";
  const list = await listIms(ctx);
  const ims = list.items.filter((im) => !im.is_user_deleted && !im.is_archived);
  const failed: string[] = [];
  let pages = list.pages;
  let items = 0;
  for (const im of ims.slice(0, MAX_IMS)) {
    try {
      const h = await recentHistory(ctx, im.id, 50);
      pages += h.pages;
      const latest = h.items.find(isHuman);
      if (!latest) continue;
      items++;
      const awaiting = latest.user !== self.userId;
      out.push(messageObservation({ self, kind: "slack_dm", channel: im.id, msg: latest, awaiting, attentionKind: "pending_reply", why: "The latest message in this direct conversation is from someone else." }));
    } catch (e) {
      if (!isChannelError(e) && asRemoteError(e).state !== "partial") throw e;
      failed.push(im.id);
    }
  }
  const notes: string[] = [];
  if (ims.length > MAX_IMS) notes.push(`Read ${MAX_IMS} of ${ims.length} direct conversations`);
  if (failed.length) notes.push(`Could not read ${failed.length} conversation(s): ${failed.join(", ")}`);
  const complete = list.complete && ims.length <= MAX_IMS && !failed.length;
  cov.add(label, listingState({ items: [], complete }, items), items, pages, listingNote(list, MAX_LIST_PAGES, notes));
}

async function syncMentions(ctx: AdapterContext, self: Self, cov: CoverageTracker, out: Observation[]) {
  const since = windowStart(ctx);
  const r = await paginate<SlackMatch>(
    async (cursor) => {
      const page = Number(cursor ?? 1);
      const res = await call<{ messages?: { matches?: SlackMatch[]; paging?: { pages?: number }; pagination?: { page_count?: number } } }>(ctx, "search.messages", { query: `<@${self.userId}>`, sort: "timestamp", sort_dir: "desc", count: 50, page });
      const matches = res.messages?.matches ?? [];
      const pageCount = res.messages?.pagination?.page_count ?? res.messages?.paging?.pages ?? 1;
      const reachedWindowEnd = matches.some((m) => Number(m.ts) < since);
      return { items: matches.filter((m) => Number(m.ts) >= since), next: !reachedWindowEnd && page < pageCount ? String(page + 1) : null };
    },
    { maxPages: MAX_SEARCH_PAGES },
  );
  const mine = r.items.filter((m) => m.user !== self.userId && m.channel?.id);
  for (const m of mine) {
    out.push(messageObservation({ self, kind: "slack_mention", channel: m.channel!.id!, msg: m, awaiting: true, attentionKind: "mention", why: "Someone @mentioned you in Slack in the last 48 hours.", ...(m.permalink ? { permalink: m.permalink } : {}), ...(m.channel?.name ? { channelName: m.channel.name } : {}) }));
  }
  cov.add("Mentions of me (48 hours)", listingState(r, mine.length), mine.length, r.pages, listingNote(r, MAX_SEARCH_PAGES));
}

async function syncChannels(ctx: AdapterContext, self: Self, cov: CoverageTracker, out: Observation[]) {
  const label = "Watched channels (48 hours)";
  const requested = csvList(stringSetting(ctx.connection.settings, "channels"));
  if (!requested.length) {
    cov.add(label, "not_configured", 0, 0, "No channels configured to watch");
    return;
  }
  const missing: string[] = [];
  let pages = 0;
  let items = 0;
  let capped = false;
  for (const channel of requested) {
    if (!CHANNEL_ID.test(channel)) {
      missing.push(`${channel} (not a channel ID)`);
      continue;
    }
    try {
      const h = await recentHistory(ctx, channel, 100);
      pages += h.pages;
      if (!h.complete) capped = true;
      for (const msg of h.items.filter(isHuman)) {
        items++;
        out.push(messageObservation({ self, kind: "slack_channel_message", channel, msg, awaiting: false, attentionKind: null, why: "" }));
      }
    } catch (e) {
      if (!isChannelError(e) && asRemoteError(e).state !== "partial") throw e;
      missing.push(`${channel} (${e instanceof SlackError ? e.code : asRemoteError(e).message})`);
    }
  }
  const notes = [...(missing.length ? [`Not read: ${missing.join(", ")}`] : []), ...(capped ? ["Some channels had more messages than one page"] : [])];
  const complete = !missing.length && !capped;
  cov.add(label, listingState({ items: [], complete }, items), items, pages, notes.length ? notes.join("; ") : undefined);
}

const SCOPES: Array<{ id: string; label: string; run: typeof syncDms }> = [
  { id: "dms", label: "Direct messages (48 hours)", run: syncDms },
  { id: "mentions", label: "Mentions of me (48 hours)", run: syncMentions },
  { id: "channels", label: "Watched channels (48 hours)", run: syncChannels },
];

function hasEffect(m: SlackMessage, key: string): boolean {
  return m.metadata?.event_type === EFFECT_EVENT && m.metadata.event_payload?.key === key;
}

function postTarget(target: Record<string, unknown>): { channel: string; threadTs: string | null } {
  const channel = String(target.channel ?? "");
  const threadTs = target.thread_ts ? String(target.thread_ts) : null;
  if (!CHANNEL_ID.test(channel)) throw new RemoteError("Invalid Slack channel", "error");
  if (threadTs && !/^\d+\.\d+$/.test(threadTs)) throw new RemoteError("Invalid Slack thread", "error");
  return { channel, threadTs };
}

async function readBack(ctx: AdapterContext, channel: string, threadTs: string | null, ts: string): Promise<SlackMessage | null> {
  const r = threadTs
    ? await call<{ messages?: SlackMessage[] }>(ctx, "conversations.replies", { channel, ts: threadTs, oldest: ts, latest: ts, inclusive: true, limit: 2, include_all_metadata: true })
    : await call<{ messages?: SlackMessage[] }>(ctx, "conversations.history", { channel, latest: ts, inclusive: true, limit: 1, include_all_metadata: true });
  return (r.messages ?? []).find((m) => m.ts === ts) ?? null;
}

export const slackAdapter: ConnectorAdapter = {
  kind: "slack",
  secretNames: ["token"],
  definition: {
    kind: "slack",
    label: "Slack",
    description: "Direct messages waiting for your reply, @mentions, and optionally chosen channels.",
    authMethods: [
      {
        id: "token",
        label: "Slack token",
        fields: [
          { id: "token", label: "Token", secret: true, placeholder: "xoxp-…", help: "A user token (xoxp-) from your own Slack app is recommended: it can read your DMs and search mentions. Scopes: im:read, im:history, search:read, channels:history, groups:history, users:read; add chat:write only to authorise posting. A bot token (xoxb-) works for channels it is in but cannot search mentions." },
          { id: "channels", label: "Channels to watch", secret: false, optional: true, placeholder: "C0123ABCD, C0456EFGH", help: "Comma-separated channel IDs (from the channel's About panel)." },
        ],
      },
    ],
    scopes: [
      { id: "dms", label: "Direct messages awaiting my reply", default: true },
      { id: "mentions", label: "Messages that @mention me", default: true },
      { id: "channels", label: "Watched channels", default: false },
    ],
    writeActions: [{ id: "slack.post", label: "Post a message or thread reply" }],
    setupHelp: "Create a Slack app for your workspace, add the user token scopes listed under the token field, install it to the workspace and paste the User OAuth Token. Messages are only posted after you approve each draft.",
    unavoidableSteps: ["Create a Slack app at api.slack.com/apps, add user token scopes, and install it to your workspace (an admin may need to approve it)."],
  },

  async configure(ctx, fields) {
    const token = fields.token?.trim() ?? "";
    if (!/^xox[bp]-/.test(token)) throw new RemoteError("Enter a Slack user token (xoxp-…) or bot token (xoxb-…)", "unauthorized");
    const channels = csvList(fields.channels ?? "");
    const bad = channels.filter((c) => !CHANNEL_ID.test(c));
    if (bad.length) throw new RemoteError(`Not a channel ID: ${bad.join(", ")}`, "not_configured");
    await ctx.setSecret("token", token);
    return { channels: channels.join(","), tokenType: token.startsWith("xoxp-") ? "user" : "bot", authMethod: "token" };
  },

  async test(ctx) {
    try {
      const me = await whoAmI(ctx);
      const account = me.user && me.team ? `${me.user} @ ${me.team}` : (me.user ?? me.userId);
      return { ok: true, state: "complete", account, message: `Signed in as ${account}` };
    } catch (e) {
      const err = asRemoteError(e);
      return { ok: false, state: err.state, account: null, message: err.message };
    }
  },

  async sync(ctx): Promise<SyncResult> {
    const cov = new CoverageTracker();
    const observations: Observation[] = [];
    const selected = SCOPES.filter((s) => ctx.connection.readScopes.includes(s.id));
    if (!selected.length) return { coverage: cov.finish(), observations };
    let self: Self;
    try {
      self = await whoAmI(ctx);
    } catch (e) {
      for (const s of selected) recordFailure(cov, s.label, e);
      return { coverage: cov.finish(), observations };
    }
    for (const s of selected) {
      try {
        await s.run(ctx, self, cov, observations);
      } catch (e) {
        recordFailure(cov, s.label, e);
      }
    }
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
    const body = { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}), metadata: { event_type: EFFECT_EVENT, event_payload: { key: action.effectKey } } };
    const res = await call<{ channel: string; ts: string }>(ctx, "chat.postMessage", body, { post: true, retries: 0 });
    const msg = await readBack(ctx, res.channel ?? channel, threadTs, res.ts);
    const verified = !!msg && hasEffect(msg, action.effectKey);
    return { verified, remoteId: res.ts, detail: { channel: res.channel ?? channel, ts: res.ts, threadTs } };
  },

  async findEffect(ctx, action) {
    const { channel, threadTs } = postTarget(action.target);
    const oldest = ((ctx.now().getTime() - 7 * 86_400_000) / 1000).toFixed(6);
    const method = threadTs ? "conversations.replies" : "conversations.history";
    const r = await paginate<SlackMessage>(
      async (cursor) => {
        const res = await call<{ messages?: SlackMessage[]; has_more?: boolean; response_metadata?: { next_cursor?: string } }>(ctx, method, { channel, ...(threadTs ? { ts: threadTs } : {}), oldest, limit: 200, include_all_metadata: true, cursor: cursor ?? undefined });
        return { items: res.messages ?? [], next: res.has_more ? cursorOf(res) : null };
      },
      { maxPages: 5 },
    );
    const found = r.items.find((m) => hasEffect(m, action.effectKey));
    if (found) return { verified: true, remoteId: found.ts, detail: { channel, ts: found.ts, threadTs, recovered: true } };
    if (!r.complete) throw new RemoteError("Could not read all recent messages to check for an earlier attempt", "partial");
    return null;
  },
};
