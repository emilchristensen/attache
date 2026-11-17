/**
 * Gmail through the user's claude.ai Gmail connector (see claude-adapter.ts).
 * search_threads lists the inbox. The connector's search results stopped
 * carrying dates and labels (and strip dots from addresses), so a thread
 * without them is completed with get_thread in its MINIMAL format: metadata,
 * subject and snippet, never bodies. The one write
 * saves a reply as a draft (create_draft); Attache never sends mail.
 */
import type { ConnectorAdapter, AdapterContext, Observation, RefreshResult, ExecuteResult } from "./types.ts";
import { CoverageTracker } from "./types.ts";
import { RemoteError, afterWrite } from "./http.ts";
import { asRemoteError, attemptStartMs, recordFailure } from "./common.ts";
import { CLAUDE_SERVERS, callOne, claudeAuthMethods, claudeDataNote, claudeSetupSteps, configureClaude, paginateStreams, serverName, streamOrThrow, testClaude, toolError } from "./claude-adapter.ts";
import { str } from "./atlassian-shapes.ts";
import { plural } from "@attache/contracts";

export interface GmailMessage {
  id: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  subject?: string;
  sender?: string;
  date?: string;
  internalDate?: string;
  toRecipients?: string[];
}

export interface GmailThread {
  id: string;
  messages?: GmailMessage[];
  viewUrl?: string;
}

const WINDOW_DAYS = 7;
const MAX_PAGES = 4;
const PAGE_SIZE = 25;
const SCOPE_LABEL = "Inbox threads (7 days)";
const THREAD_ID = /^[A-Za-z0-9]+$/;
/** get_thread calls per Claude Code session: small enough to finish well inside the session timeout. */
const DETAIL_BATCH = 10;

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

const server = (ctx: AdapterContext) => serverName(ctx, CLAUDE_SERVERS.gmail);

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
  const d = Date.parse(m.date ?? "");
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
  snippet: string;
  url: string;
}

/** Classify a thread. Unread/important come only from Gmail labels; the last message decides who owes a reply. */
export function summarizeThread(t: GmailThread, selfEmail: string | null): ThreadSummary | null {
  const messages = [...(t.messages ?? [])].sort((a, b) => (messageTime(a) ?? 0) - (messageTime(b) ?? 0));
  const last = messages[messages.length - 1];
  if (!last?.id) return null;
  const at = messageTime(last);
  const labels = (m: GmailMessage) => m.labelIds ?? [];
  const from = last.sender ?? "";
  const subject = last.subject || messages.find((m) => m.subject)?.subject || "";
  const fromSelf = labels(last).includes("SENT") || (!!selfEmail && emailAddress(from) === selfEmail.toLowerCase());
  const calendarNotification = isCalendarNotification(subject, from);
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
    snippet: last.snippet ?? "",
    url: t.viewUrl && /^https:\/\/mail\.google\.com\//.test(t.viewUrl) ? t.viewUrl : `https://mail.google.com/mail/u/0/#inbox/${t.id}`,
  };
}

function toObservation(s: ThreadSummary): Observation {
  const pending = s.awaiting && (s.unread || s.important);
  return {
    kind: "gmail_thread",
    externalId: s.threadId,
    title: s.subject || "(no subject)",
    url: s.url,
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
            url: s.url,
            priority: s.important ? 70 : 60,
            draftable: { actionKind: "gmail.draft", target: { threadId: s.threadId, to: emailAddress(s.from), subject: s.subject, replyToMessageId: s.lastMessageId }, context: { from: s.from, subject: s.subject, snippet: s.snippet } },
          },
        }
      : {}),
  };
}

/** Parse one search_threads page. "{}" is the connector's documented empty result. */
export function parseThreadPage(text: string): { items: GmailThread[]; next: string | null; unreadable: number } {
  let res: { threads?: unknown; nextPageToken?: unknown };
  try {
    res = JSON.parse(text) as typeof res;
  } catch {
    throw new RemoteError("Gmail search returned an unreadable result", "error");
  }
  if (!res || typeof res !== "object") throw new RemoteError("Gmail search returned an unreadable result", "error");
  // An error reported inside the result, not as a tool error, is still an error.
  const err = (res as { error?: unknown }).error;
  if (err !== undefined) throw toolError("Gmail", "search_threads", typeof err === "string" ? err : JSON.stringify(err));
  const threads = res.threads === undefined ? [] : res.threads;
  if (!Array.isArray(threads)) throw new RemoteError("Gmail search returned an unexpected result shape", "error");
  const items = threads.filter((t): t is GmailThread => !!t && typeof t === "object" && typeof (t as GmailThread).id === "string" && THREAD_ID.test((t as GmailThread).id));
  return { items, next: str(res.nextPageToken), unreadable: threads.length - items.length };
}

/** A search result without a date or labels on every message cannot say who owes a reply or how old the thread is. */
function needsDetails(t: GmailThread): boolean {
  return !t.messages?.length || t.messages.some((m) => !m.labelIds || !(m.internalDate || m.date));
}

/** Parse one get_thread result; anything else is null, so the thread stays undated. */
export function parseThread(text: string, threadId: string): GmailThread | null {
  try {
    const t = JSON.parse(text) as GmailThread;
    return t && t.id === threadId && Array.isArray(t.messages) ? t : null;
  } catch {
    return null;
  }
}

/** Complete the threads that need it with get_thread; a thread that cannot be read is returned unchanged (and counts as undated). */
async function withDetails(ctx: AdapterContext, threads: GmailThread[]): Promise<{ threads: GmailThread[]; error: RemoteError | null }> {
  const missing = threads.filter(needsDetails);
  const batches = Array.from({ length: Math.ceil(missing.length / DETAIL_BATCH) }, (_, i) => missing.slice(i * DETAIL_BATCH, (i + 1) * DETAIL_BATCH));
  const detailed = new Map<string, GmailThread>();
  let error: RemoteError | null = null;
  await Promise.all(
    batches.map(async (batch) => {
      const calls = batch.map((t) => ({ id: t.id, tool: "get_thread", args: { threadId: t.id, messageFormat: "MINIMAL" } }));
      try {
        const outcomes = await ctx.claude.run(server(ctx), calls, { signal: ctx.signal });
        for (const c of calls) {
          const o = outcomes.get(c.id);
          const t = o?.status === "ok" ? parseThread(o.text, c.id) : null;
          if (t) detailed.set(c.id, t);
        }
      } catch (e) {
        error ??= asRemoteError(e);
      }
    }),
  );
  return { threads: threads.map((t) => detailed.get(t.id) ?? t), error };
}

async function syncInbox(ctx: AdapterContext, cov: CoverageTracker, out: Observation[]) {
  const results = await paginateStreams<GmailThread>(ctx, server(ctx), [
    {
      id: "inbox",
      label: SCOPE_LABEL,
      maxPages: MAX_PAGES,
      call: (cursor) => ({ tool: "search_threads", args: { query: `in:inbox newer_than:${WINDOW_DAYS}d`, pageSize: PAGE_SIZE, view: "THREAD_VIEW_MINIMAL", ...(cursor ? { pageToken: cursor } : {}) } }),
      parse: parseThreadPage,
    },
  ]);
  const r = streamOrThrow(results.get("inbox"));
  const details = await withDetails(ctx, r.items);
  const windowStart = ctx.now().getTime() - WINDOW_DAYS * 86_400_000;
  const selfEmail = ctx.selfEmail ?? ctx.connection.account;
  let dropped = 0;
  let undated = 0;
  let items = 0;
  for (const t of details.threads) {
    const s = summarizeThread(t, selfEmail);
    // A thread that cannot be dated or read is unreadable (partial); unknown age is not freshness.
    if (!s || !s.lastMessageAt) {
      undated++;
      continue;
    }
    if (Date.parse(s.lastMessageAt) < windowStart) {
      dropped++;
      continue;
    }
    items++;
    out.push(toObservation(s));
  }
  const notes = [
    ...(r.error ? [r.error.message] : !r.complete ? [`Read the newest ${plural(r.items.length, "thread")} (${MAX_PAGES} pages)`] : []),
    ...(r.unreadable + undated ? [`${plural(r.unreadable + undated, "thread")} could not be read or dated`] : []),
    ...(details.error ? [`Thread details: ${details.error.message}`] : []),
    ...(dropped ? [`Skipped ${plural(dropped, "thread")} outside the ${WINDOW_DAYS}-day window`] : []),
  ];
  const complete = r.complete && !r.unreadable && !undated;
  cov.add(SCOPE_LABEL, complete ? (items ? "complete" : "empty") : "partial", items, r.pages, notes.length ? notes.join("; ") : undefined);
}

function draftTarget(target: Record<string, unknown>) {
  const threadId = String(target.threadId ?? "");
  const to = String(target.to ?? "").trim();
  const replyToMessageId = String(target.replyToMessageId ?? "");
  if (!THREAD_ID.test(threadId)) throw new RemoteError("Invalid Gmail thread", "error");
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(to)) throw new RemoteError("The draft has no valid recipient", "error");
  if (replyToMessageId && !THREAD_ID.test(replyToMessageId)) throw new RemoteError("Invalid Gmail message", "error");
  return { threadId, to, subject: String(target.subject ?? ""), replyToMessageId };
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
}

interface Draft {
  id?: string;
  date?: string;
  threadId?: string;
  thread_id?: string;
  viewUrl?: string;
  plaintextBody?: string;
  plaintext_body?: string;
  message?: { threadId?: string; plaintextBody?: string; plaintext_body?: string };
}

const draftThread = (d: Draft) => d.threadId ?? d.thread_id ?? d.message?.threadId ?? null;
const draftBody = (d: Draft) => d.plaintextBody ?? d.plaintext_body ?? d.message?.plaintextBody ?? d.message?.plaintext_body ?? "";
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

function selfEmailOf(text: string): string | null {
  return /authuser=([^&#\s"]+@[^&#\s"]+)/.exec(text)?.[1] ?? null;
}

export const gmailAdapter: ConnectorAdapter = {
  kind: "gmail",
  secretNames: [],
  definition: {
    kind: "gmail",
    label: "Gmail",
    description: "Recent inbox threads where someone is waiting for your reply.",
    authMethods: claudeAuthMethods(CLAUDE_SERVERS.gmail),
    scopes: [{ id: "inbox_recent", label: "Inbox threads from the last 7 days", default: true }],
    writeActions: [{ id: "gmail.draft", label: "Save a reply as a Gmail draft (never sends)" }],
    setupHelp: `${claudeDataNote(CLAUDE_SERVERS.gmail)} Attache never sends mail; with drafting authorised it only saves replies as Gmail drafts.`,
    unavoidableSteps: claudeSetupSteps(CLAUDE_SERVERS.gmail),
  },

  configure: async (_ctx, fields) => configureClaude(fields, CLAUDE_SERVERS.gmail),

  async test(ctx) {
    return testClaude(ctx, server(ctx), { tool: "search_threads", args: { query: "in:inbox", pageSize: 1, view: "THREAD_VIEW_METADATA_ONLY" } }, (text) => {
      parseThreadPage(text);
      return { account: selfEmailOf(text) };
    });
  },

  async refresh(ctx): Promise<RefreshResult> {
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
    const t = draftTarget(action.target);
    const body = String(action.payload.body ?? "").trim();
    if (!body) throw new RemoteError("The draft is empty", "error");
    const raw = await callOne(ctx, server(ctx), "create_draft", { to: [t.to], subject: replySubject(t.subject), body, ...(t.replyToMessageId ? { replyToMessageId: t.replyToMessageId } : {}) }, { write: true });
    let created: Draft = {};
    try {
      created = JSON.parse(raw) as Draft;
    } catch {
      // Unreadable confirmation: reported as unverified below.
    }
    if (!created.id) return { verified: false, detail: { threadId: t.threadId, note: "Gmail did not return a draft id", response: raw.slice(0, 300) } };
    const check = await afterWrite(async () => JSON.parse(await callOne(ctx, server(ctx), "get_draft", { draftId: created.id, messageFormat: "MINIMAL" })) as Draft);
    const verified = !!check && (check.id === created.id || !!check.message);
    return { verified, remoteId: created.id, ...(created.viewUrl ? { url: created.viewUrl } : {}), detail: { threadId: draftThread(created) ?? t.threadId } };
  },

  async findEffect(ctx, action) {
    const t = draftTarget(action.target);
    const body = squash(String(action.payload.body ?? ""));
    const text = await callOne(ctx, server(ctx), "list_drafts", { pageSize: 50, view: "DRAFT_VIEW_FULL" });
    let res: { drafts?: Draft[]; nextPageToken?: string } = {};
    try {
      res = JSON.parse(text) as typeof res;
    } catch {
      throw new RemoteError("Gmail returned an unreadable draft list", "error");
    }
    // The connector cannot set custom headers, so an earlier attempt is recognised by thread, time and body.
    const fromMs = attemptStartMs(action.since, 0);
    const found = (res.drafts ?? []).find((d) => {
      const at = Date.parse(d.date ?? "");
      return draftThread(d) === t.threadId && !(Number.isFinite(at) && at < fromMs) && body.length > 0 && squash(draftBody(d)).startsWith(body);
    });
    if (found?.id) return { verified: true, remoteId: found.id, ...(found.viewUrl ? { url: found.viewUrl } : {}), detail: { threadId: t.threadId, recovered: true, matchedBy: "thread and body" } };
    if (res.nextPageToken) throw new RemoteError("More than 50 drafts; could not check them all for an earlier attempt", "partial");
    return null;
  },
};
