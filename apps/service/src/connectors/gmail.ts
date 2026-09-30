import type { ConnectorAdapter, AdapterContext, Observation, SyncResult, ExecuteResult } from "./types.ts";
import { CoverageTracker } from "./types.ts";
import { RemoteError, afterWrite, paginate } from "./http.ts";
import { asRemoteError, listingNote, recordFailure } from "./common.ts";
import { GOOGLE_SECRET_NAMES, buildAuthorizeUrl, completeGoogleAuthorization, configureGoogle, googleAuthMethod, googleRequest, googleSetupSteps, grantedScopes } from "./google.ts";

interface GmailHeader {
  name: string;
  value: string;
}

interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: { headers?: GmailHeader[] };
}

interface GmailThread {
  id: string;
  messages?: GmailMessage[];
}

interface GmailDraft {
  id: string;
  message?: GmailMessage;
}

export const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_COMPOSE_SCOPE = "https://www.googleapis.com/auth/gmail.compose";
/** Scopes that include permission to create drafts. */
const DRAFT_CAPABLE = [GMAIL_COMPOSE_SCOPE, "https://www.googleapis.com/auth/gmail.modify", "https://mail.google.com/"];

const DEFAULT_BASE = "https://gmail.googleapis.com";
const WINDOW_DAYS = 7;
const MAX_LIST_PAGES = 4;
const MAX_THREADS = 100;
const EFFECT_HEADER = "X-Jarvis-Effect";
const THREAD_HEADERS = ["From", "Subject", "Date", "Message-ID", "Reply-To", "References"];
const SCOPE_LABEL = "Inbox threads (7 days)";

/** Case-insensitive substrings identifying calendar notification mail, which never needs a reply. */
export const CALENDAR_NOTIFICATION_MARKERS = [
  "invitation:",
  "accepted:",
  "declined:",
  "tentatively accepted:",
  "updated invitation:",
  "invitation with note:",
  "canceled event:",
  "cancelled event:",
  "new time proposed:",
  "invitation from google calendar",
  "calendar-notification@google.com",
];

function base(ctx: AdapterContext): string {
  return `${ctx.endpoint(DEFAULT_BASE).replace(/\/$/, "")}/gmail/v1/users/me`;
}

export function header(m: GmailMessage | undefined, name: string): string {
  const h = (m?.payload?.headers ?? []).find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

export function emailAddress(from: string): string {
  const m = /<([^>]+)>/.exec(from);
  return (m ? m[1]! : from).trim().toLowerCase();
}

function displayName(from: string): string {
  const m = /^\s*"?([^"<]+?)"?\s*</.exec(from);
  return m ? m[1]!.trim() : emailAddress(from);
}

export function isCalendarNotification(subject: string, from: string): boolean {
  const hay = `${subject}\n${from}`.toLowerCase();
  return CALENDAR_NOTIFICATION_MARKERS.some((m) => hay.includes(m));
}

function messageTime(m: GmailMessage): number | null {
  const internal = Number(m.internalDate);
  if (Number.isFinite(internal) && internal > 0) return internal;
  const d = Date.parse(header(m, "Date"));
  return Number.isFinite(d) ? d : null;
}

export interface ThreadSummary {
  threadId: string;
  subject: string;
  from: string;
  lastMessageId: string;
  lastMessageAt: string | null;
  unread: boolean;
  important: boolean;
  fromSelf: boolean;
  calendarNotification: boolean;
  awaiting: boolean;
  replyTo: string;
  messageIdHeader: string;
  references: string;
  snippet: string;
}

/** Classify a thread. Unread/important come only from Gmail labels; the last message decides who owes a reply. */
export function summarizeThread(t: GmailThread, selfEmail: string | null): ThreadSummary | null {
  const messages = [...(t.messages ?? [])].sort((a, b) => (messageTime(a) ?? 0) - (messageTime(b) ?? 0));
  const last = messages[messages.length - 1];
  if (!last) return null;
  const at = messageTime(last);
  const labels = (m: GmailMessage) => m.labelIds ?? [];
  const from = header(last, "From");
  const subject = header(last, "Subject") || header(messages[0], "Subject");
  const fromSelf = labels(last).includes("SENT") || (!!selfEmail && emailAddress(from) === selfEmail.toLowerCase());
  const calendarNotification = isCalendarNotification(subject, from);
  const messageIdHeader = header(last, "Message-ID");
  return {
    threadId: t.id,
    subject,
    from,
    lastMessageId: last.id,
    lastMessageAt: at === null ? null : new Date(at).toISOString(),
    unread: messages.some((m) => labels(m).includes("UNREAD")),
    important: messages.some((m) => labels(m).includes("IMPORTANT")),
    fromSelf,
    calendarNotification,
    awaiting: !fromSelf && !calendarNotification,
    replyTo: header(last, "Reply-To") || from,
    messageIdHeader,
    references: [header(last, "References"), messageIdHeader].filter(Boolean).join(" ").trim(),
    snippet: last.snippet ?? "",
  };
}

function toObservation(s: ThreadSummary): Observation {
  const url = `https://mail.google.com/mail/u/0/#inbox/${s.threadId}`;
  const pending = s.awaiting && (s.unread || s.important);
  return {
    kind: "gmail_thread",
    externalId: s.threadId,
    title: s.subject || "(no subject)",
    url,
    author: s.from,
    ...(s.lastMessageAt ? { occurredAt: s.lastMessageAt } : {}),
    data: { unread: s.unread, important: s.important, awaiting: s.awaiting, fromSelf: s.fromSelf, calendarNotification: s.calendarNotification, lastMessageId: s.lastMessageId, snippet: s.snippet.slice(0, 1000) },
    fingerprintParts: [s.lastMessageId, s.awaiting],
    ...(pending
      ? {
          attention: {
            key: `gmail:${s.threadId}`,
            kind: "pending_reply",
            title: `Reply to ${displayName(s.from)}: ${s.subject || "(no subject)"}`,
            summary: s.snippet.slice(0, 280),
            why: `The latest message is from someone else and the thread is ${[s.unread ? "unread" : "", s.important ? "marked important" : ""].filter(Boolean).join(" and ")}.`,
            url,
            priority: s.important ? 70 : 60,
            draftable: { actionKind: "gmail.draft", target: { threadId: s.threadId, to: s.replyTo, subject: s.subject, inReplyTo: s.messageIdHeader, references: s.references }, context: { from: s.from, subject: s.subject, snippet: s.snippet } },
          },
        }
      : {}),
  };
}

async function listThreadIds(ctx: AdapterContext) {
  return paginate<{ id: string }>(
    async (cursor) => {
      const qs = new URLSearchParams({ q: `in:inbox newer_than:${WINDOW_DAYS}d`, maxResults: "50" });
      if (cursor) qs.set("pageToken", cursor);
      const res = await googleRequest<{ threads?: Array<{ id: string }>; nextPageToken?: string }>(ctx, { url: `${base(ctx)}/threads?${qs}` });
      return { items: res.data.threads ?? [], next: res.data.nextPageToken ?? null };
    },
    { maxPages: MAX_LIST_PAGES },
  );
}

async function fetchThread(ctx: AdapterContext, id: string): Promise<GmailThread> {
  const qs = new URLSearchParams({ format: "metadata" });
  for (const h of THREAD_HEADERS) qs.append("metadataHeaders", h);
  const res = await googleRequest<GmailThread>(ctx, { url: `${base(ctx)}/threads/${encodeURIComponent(id)}?${qs}` });
  return res.data;
}

async function syncInbox(ctx: AdapterContext, cov: CoverageTracker, out: Observation[]) {
  const list = await listThreadIds(ctx);
  const windowStart = ctx.now().getTime() - WINDOW_DAYS * 86_400_000;
  const selfEmail = ctx.selfEmail ?? ctx.connection.account;
  let failed = 0;
  let dropped = 0;
  let items = 0;
  for (const { id } of list.items.slice(0, MAX_THREADS)) {
    let thread: GmailThread;
    try {
      thread = await fetchThread(ctx, id);
    } catch (e) {
      const err = asRemoteError(e);
      if (err.state === "unauthorized" || err.state === "denied") throw err;
      failed++;
      continue;
    }
    const s = summarizeThread(thread, selfEmail);
    if (!s || !s.lastMessageAt || Date.parse(s.lastMessageAt) < windowStart) {
      dropped++;
      continue;
    }
    items++;
    out.push(toObservation(s));
  }
  const capped = list.items.length > MAX_THREADS;
  const notes = [
    ...(capped ? [`Read the newest ${MAX_THREADS} of ${list.items.length}+ threads`] : []),
    ...(failed ? [`${failed} thread(s) could not be read`] : []),
    ...(dropped ? [`${dropped} thread(s) outside the ${WINDOW_DAYS}-day window or undated were skipped`] : []),
  ];
  const complete = list.complete && !capped && !failed;
  cov.add(SCOPE_LABEL, complete ? (items ? "complete" : "empty") : "partial", items, list.pages, listingNote(list, MAX_LIST_PAGES, notes));
}

function assertHeaderSafe(name: string, value: string): string {
  if (/[\r\n]/.test(value)) throw new RemoteError(`Invalid ${name} header`, "error");
  return value;
}

function encodeHeaderValue(value: string): string {
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
}

/** RFC 822 reply as base64url, carrying the effect key in a custom header for recovery. */
export function buildRawReply(p: { to: string; subject: string; inReplyTo: string; references: string; body: string; effectKey: string }): string {
  const headers = [
    `To: ${assertHeaderSafe("To", p.to)}`,
    `Subject: ${encodeHeaderValue(assertHeaderSafe("Subject", replySubject(p.subject)))}`,
    ...(p.inReplyTo ? [`In-Reply-To: ${assertHeaderSafe("In-Reply-To", p.inReplyTo)}`] : []),
    ...(p.references ? [`References: ${assertHeaderSafe("References", p.references)}`] : []),
    `${EFFECT_HEADER}: ${assertHeaderSafe(EFFECT_HEADER, p.effectKey)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const body = (Buffer.from(p.body, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${body}\r\n`, "utf8").toString("base64url");
}

function draftTarget(target: Record<string, unknown>) {
  const threadId = String(target.threadId ?? "");
  const to = String(target.to ?? "").trim();
  if (!/^[A-Za-z0-9]+$/.test(threadId)) throw new RemoteError("Invalid Gmail thread", "error");
  if (!to.includes("@")) throw new RemoteError("The draft has no recipient", "error");
  const inReplyTo = String(target.inReplyTo ?? "");
  return { threadId, to, subject: String(target.subject ?? ""), inReplyTo, references: String(target.references ?? inReplyTo) };
}

const draftUrl = (messageId: string | undefined) => (messageId ? `https://mail.google.com/mail/u/0/#drafts?compose=${messageId}` : undefined);

async function draftCarriesEffect(ctx: AdapterContext, messageId: string, effectKey: string): Promise<boolean> {
  const res = await googleRequest<GmailMessage>(ctx, { url: `${base(ctx)}/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=${EFFECT_HEADER}` });
  return header(res.data, EFFECT_HEADER) === effectKey;
}

async function identify(ctx: AdapterContext): Promise<string | null> {
  const res = await googleRequest<{ emailAddress?: string }>(ctx, { url: `${base(ctx)}/profile`, retries: 1 });
  return res.data.emailAddress ?? null;
}

export const gmailAdapter: ConnectorAdapter = {
  kind: "gmail",
  secretNames: GOOGLE_SECRET_NAMES,
  definition: {
    kind: "gmail",
    label: "Gmail",
    description: "Recent inbox threads where someone is waiting for your reply.",
    authMethods: [googleAuthMethod()],
    scopes: [{ id: "inbox_recent", label: "Inbox threads from the last 7 days", default: true }],
    writeActions: [{ id: "gmail.draft", label: "Save a reply as a Gmail draft (never sends)" }],
    setupHelp: "Jarvis reads Gmail with read-only access. Saving drafts needs a separate, additional Google permission (gmail.compose) that you grant only if you authorise drafting. Jarvis never sends mail.",
    unavoidableSteps: googleSetupSteps("Gmail API"),
  },

  configure: configureGoogle,

  async authorizeUrl(ctx, p) {
    return buildAuthorizeUrl(ctx, { ...p, scopes: p.scopes.length ? p.scopes : [GMAIL_READ_SCOPE] });
  },

  async completeAuthorization(ctx, p) {
    return completeGoogleAuthorization(ctx, p, identify);
  },

  async test(ctx) {
    try {
      const account = await identify(ctx);
      return { ok: true, state: "complete", account, message: `Signed in as ${account ?? "unknown"}`, grantedScopes: grantedScopes(ctx) };
    } catch (e) {
      const err = asRemoteError(e);
      return { ok: false, state: err.state, account: null, message: err.message };
    }
  },

  async sync(ctx): Promise<SyncResult> {
    const cov = new CoverageTracker();
    const observations: Observation[] = [];
    if (ctx.connection.readScopes.includes("inbox_recent")) {
      try {
        await syncInbox(ctx, cov, observations);
      } catch (e) {
        recordFailure(cov, SCOPE_LABEL, e);
      }
    }
    return { coverage: cov.finish(), observations };
  },

  async execute(ctx, action): Promise<ExecuteResult> {
    if (action.kind !== "gmail.draft") throw new RemoteError(`Unsupported action ${action.kind}`, "error");
    if (!grantedScopes(ctx).some((s) => DRAFT_CAPABLE.includes(s))) {
      throw new RemoteError("Saving Gmail drafts needs the additional gmail.compose permission. Authorise \"Save a reply as a Gmail draft\" for this connection and reconnect Google.", "denied");
    }
    const t = draftTarget(action.target);
    const body = String(action.payload.body ?? "").trim();
    if (!body) throw new RemoteError("The draft is empty", "error");
    const raw = buildRawReply({ ...t, body, effectKey: action.effectKey });
    const res = await googleRequest<GmailDraft>(ctx, { method: "POST", url: `${base(ctx)}/drafts`, body: { message: { raw, threadId: t.threadId } }, retries: 0 });
    const check = await afterWrite(() => googleRequest<GmailDraft>(ctx, { url: `${base(ctx)}/drafts/${encodeURIComponent(res.data.id)}?format=metadata` }));
    const verified = !!check && check.data.id === res.data.id && header(check.data.message, EFFECT_HEADER) === action.effectKey;
    const url = draftUrl(check?.data.message?.id ?? res.data.message?.id);
    return { verified, remoteId: res.data.id, ...(url ? { url } : {}), detail: { threadId: t.threadId, messageId: check?.data.message?.id ?? null } };
  },

  async findEffect(ctx, action) {
    const threadId = String(action.target.threadId ?? "");
    const r = await paginate<GmailDraft>(
      async (cursor) => {
        const qs = new URLSearchParams({ maxResults: "50" });
        if (cursor) qs.set("pageToken", cursor);
        const res = await googleRequest<{ drafts?: GmailDraft[]; nextPageToken?: string }>(ctx, { url: `${base(ctx)}/drafts?${qs}` });
        return { items: res.data.drafts ?? [], next: res.data.nextPageToken ?? null };
      },
      { maxPages: 4 },
    );
    const candidates = r.items.filter((d) => d.message?.id && (!threadId || d.message.threadId === threadId));
    for (const d of candidates) {
      if (await draftCarriesEffect(ctx, d.message!.id, action.effectKey)) {
        const url = draftUrl(d.message!.id);
        return { verified: true, remoteId: d.id, ...(url ? { url } : {}), detail: { threadId, messageId: d.message!.id, recovered: true } };
      }
    }
    if (!r.complete) throw new RemoteError("Could not read all drafts to check for an earlier attempt", "partial");
    return null;
  },
};
