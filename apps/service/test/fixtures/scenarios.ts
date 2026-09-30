/**
 * TEST-ONLY happy-path scenarios for every remote service Jarvis talks to,
 * mounted on the fixture server under one path prefix per service. End-to-end
 * tests mutate `scenarioState` (e.g. push a new PR head, make a Jira item
 * overdue) and re-sync to observe the change. Nothing here is live evidence.
 */
import type { FixtureRequest, FixtureResponse, FixtureServer } from "./fixture-server.ts";
import { FIXTURE_PREFIX } from "../../src/connectors/test-endpoints.ts";

export { FIXTURE_PREFIX };

type Params = string[];
type Handler = (req: FixtureRequest, params: Params) => FixtureResponse | Promise<FixtureResponse>;

interface GithubPr {
  repo: string;
  number: number;
  title: string;
  author: string;
  headSha: string;
  draft: boolean;
  body: string;
}

interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  duedate: string | null;
  priority: string;
  reporterIsMe?: boolean;
}

interface ConfluencePage {
  id: string;
  title: string;
  version: number;
  space: string;
  mentionsMe: boolean;
}

interface SlackMessage {
  ts: string;
  user?: string;
  bot_id?: string;
  text: string;
  thread_ts?: string;
  metadata?: unknown;
}

interface GmailMessage {
  id: string;
  from: string;
  subject: string;
  labels: string[];
  at: number;
}

interface CalendarEvent {
  id: string;
  summary: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
  attendees: Array<{ email: string; displayName?: string; self?: boolean; responseStatus: string }>;
  status?: string;
}

export interface ScenarioState {
  selfEmail: string;
  github: { login: string; prs: GithubPr[]; comments: Map<string, Array<{ id: number; body: string; html_url: string }>> };
  jira: { issues: JiraIssue[]; comments: Map<string, Array<{ id: string; body: unknown; properties: Array<{ key: string; value: unknown }> }>> };
  confluence: { pages: ConfluencePage[]; comments: Array<{ id: string; pageId: string; body: { storage: { value: string } } }>; properties: Map<string, Array<{ key: string; value: unknown }>> };
  slack: { selfId: string; ims: Map<string, SlackMessage[]>; channels: Map<string, SlackMessage[]>; mentions: Array<SlackMessage & { channel: string }> };
  google: { grantedScopes: string; accessToken: string; refreshToken: string; revoked: boolean; issued: number };
  gmail: { threads: Map<string, GmailMessage[]>; drafts: Array<{ id: string; messageId: string; threadId: string; headers: Array<{ name: string; value: string }> }> };
  gcal: { events: CalendarEvent[] };
  nextId: number;
}

const HOUR = 3_600_000;
const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
const CAL_READ = "https://www.googleapis.com/auth/calendar.readonly";

const localDate = (ms: number) => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const slackTs = (ms: number, n = 0) => `${Math.floor(ms / 1000)}.${String(n).padStart(6, "0")}`;
const iso = (ms: number) => new Date(ms).toISOString();

export function createScenarioState(opts: { selfEmail?: string; now?: number } = {}): ScenarioState {
  const now = opts.now ?? Date.now();
  const selfEmail = opts.selfEmail ?? "alex@example.com";
  return {
    selfEmail,
    github: {
      login: "alex",
      prs: [
        { repo: "acme/web", number: 42, title: "Add checkout retry", author: "mia", headSha: "a1b2c3", draft: false, body: "Retries failed payments once." },
        { repo: "acme/api", number: 7, title: "Rate limit search", author: "bob", headSha: "d4e5f6", draft: false, body: "Adds a token bucket." },
      ],
      comments: new Map(),
    },
    jira: {
      issues: [
        { key: "ABC-1", summary: "Finish quarterly report", status: "In Progress", duedate: localDate(now + 2 * 24 * HOUR), priority: "High" },
        { key: "ABC-2", summary: "Clean up backlog", status: "To Do", duedate: null, priority: "Low" },
      ],
      comments: new Map(),
    },
    confluence: {
      pages: [
        { id: "1001", title: "Q4 planning", version: 3, space: "ENG", mentionsMe: true },
        { id: "1002", title: "Runbook: deploys", version: 8, space: "OPS", mentionsMe: false },
      ],
      comments: [],
      properties: new Map(),
    },
    slack: {
      selfId: "U0SELF",
      ims: new Map([
        ["D0000001", [{ ts: slackTs(now - HOUR), user: "U0MIA", text: "Can you look at the checkout PR today?" }]],
        ["D0000002", [{ ts: slackTs(now - 2 * HOUR), user: "U0SELF", text: "Sent it over." }, { ts: slackTs(now - 3 * HOUR), user: "U0BOB", text: "Got the numbers?" }]],
      ]),
      channels: new Map([["C0000001", [{ ts: slackTs(now - 4 * HOUR), user: "U0BOB", text: "Standup moved to 10:30" }]]]),
      mentions: [{ channel: "C0000001", ts: slackTs(now - 5 * HOUR), user: "U0MIA", text: "<@U0SELF> can you confirm the release date?" }],
    },
    google: { grantedScopes: `${GMAIL_READ} ${CAL_READ}`, accessToken: "ya29.fixture-access-0", refreshToken: "1//fixture-refresh", revoked: false, issued: 0 },
    gmail: {
      threads: new Map([
        ["thr1", [{ id: "msg1", from: "Mia Jensen <mia@client.example>", subject: "Contract renewal", labels: ["INBOX", "UNREAD", "IMPORTANT"], at: now - 3 * HOUR }]],
        ["thr2", [{ id: "msg2", from: "Bob <bob@client.example>", subject: "Lunch?", labels: ["INBOX"], at: now - 30 * HOUR }, { id: "msg3", from: `Alex <${selfEmail}>`, subject: "Re: Lunch?", labels: ["SENT"], at: now - 20 * HOUR }]],
        ["thr3", [{ id: "msg4", from: "Google Calendar <calendar-notification@google.com>", subject: "Invitation: Design review", labels: ["INBOX", "UNREAD"], at: now - 2 * HOUR }]],
      ]),
      drafts: [],
    },
    gcal: {
      events: [
        {
          id: "evt1",
          summary: "Design review",
          start: { dateTime: iso(now + 3 * HOUR) },
          end: { dateTime: iso(now + 4 * HOUR) },
          attendees: [{ email: selfEmail, self: true, responseStatus: "accepted" }, { email: "mia@client.example", displayName: "Mia Jensen", responseStatus: "accepted" }],
        },
        {
          id: "evt2",
          summary: "Offsite planning",
          start: { dateTime: iso(now + 26 * HOUR) },
          end: { dateTime: iso(now + 27 * HOUR) },
          attendees: [{ email: selfEmail, self: true, responseStatus: "needsAction" }, { email: "bob@client.example", displayName: "Bob", responseStatus: "accepted" }],
        },
        { id: "evt3", summary: "Company holiday", start: { date: localDate(now + 24 * HOUR) }, end: { date: localDate(now + 48 * HOUR) }, attendees: [] },
      ],
    },
    nextId: 1000,
  };
}

/** The state of the most recently installed scenarios; E2E tests mutate it between syncs. */
export let scenarioState: ScenarioState = createScenarioState();

// ---------------------------------------------------------------------------
// Mutation helpers for end-to-end tests

export function setPrHeadSha(state: ScenarioState, number: number, sha: string): void {
  state.github.prs = state.github.prs.map((p) => (p.number === number ? { ...p, headSha: sha } : p));
}

export function addJiraOverdue(state: ScenarioState, key: string, summary: string, daysOverdue = 1): void {
  state.jira.issues = [...state.jira.issues.filter((i) => i.key !== key), { key, summary, status: "In Progress", duedate: localDate(Date.now() - daysOverdue * 24 * HOUR), priority: "High" }];
}

export function grantGmailCompose(state: ScenarioState): void {
  if (!state.google.grantedScopes.includes(GMAIL_COMPOSE)) state.google.grantedScopes = `${state.google.grantedScopes} ${GMAIL_COMPOSE}`;
}

// ---------------------------------------------------------------------------
// Routing helpers

function mount(fx: FixtureServer, method: string, pattern: string, handler: Handler): void {
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:[a-zA-Z]+/g, "([^/]+)")}$`);
  fx.route(method, re, (req) => handler(req, (re.exec(req.path) ?? []).slice(1).map(decodeURIComponent)));
}

const unauthorized: FixtureResponse = { status: 401, json: { message: "Missing or invalid credentials" } };
const authed = (h: Handler): Handler => (req, p) => (req.headers.authorization ? h(req, p) : unauthorized);
const json = (data: unknown, status = 200): FixtureResponse => ({ status, json: data });
const id = (s: ScenarioState) => String(++s.nextId);

// ---------------------------------------------------------------------------
// GitHub (api.github.com)

function mountGithub(fx: FixtureServer, s: () => ScenarioState) {
  const P = FIXTURE_PREFIX["https://api.github.com"];
  mount(fx, "GET", `${P}/user`, authed(() => ({ json: { login: s().github.login }, headers: { "x-oauth-scopes": "repo" } })));
  mount(fx, "GET", `${P}/search/issues`, authed((req) => {
    const q = req.query.get("q") ?? "";
    const prs = q.includes("review-requested:@me") ? s().github.prs : [];
    const items = prs.map((p) => ({ number: p.number, title: p.title, html_url: `https://github.com/${p.repo}/pull/${p.number}`, state: "open", draft: p.draft, user: { login: p.author }, repository_url: `https://api.github.com/repos/${p.repo}`, created_at: iso(Date.now() - 24 * HOUR), updated_at: iso(Date.now() - HOUR), body: p.body, pull_request: {} }));
    return json({ total_count: items.length, incomplete_results: false, items });
  }));
  mount(fx, "GET", `${P}/repos/:owner/:repo/pulls/:n`, authed((_req, [o, r, n]) => {
    const pr = s().github.prs.find((p) => p.repo === `${o}/${r}` && p.number === Number(n));
    return pr ? json({ number: pr.number, head: { sha: pr.headSha } }) : json({ message: "Not Found" }, 404);
  }));
  mount(fx, "POST", `${P}/repos/:owner/:repo/issues/:n/comments`, authed((req, [o, r, n]) => {
    const key = `${o}/${r}#${n}`;
    const list = s().github.comments.get(key) ?? [];
    const c = { id: Number(id(s())), body: String((req.body as { body?: string }).body ?? ""), html_url: `https://github.com/${o}/${r}/pull/${n}#issuecomment-${s().nextId}` };
    s().github.comments.set(key, [...list, c]);
    return json(c, 201);
  }));
  mount(fx, "GET", `${P}/repos/:owner/:repo/issues/comments/:id`, authed((_req, [, , cid]) => {
    const c = [...s().github.comments.values()].flat().find((x) => String(x.id) === cid);
    return c ? json(c) : json({ message: "Not Found" }, 404);
  }));
  mount(fx, "GET", `${P}/repos/:owner/:repo/issues/:n/comments`, authed((_req, [o, r, n]) => json(s().github.comments.get(`${o}/${r}#${n}`) ?? [])));
}

// ---------------------------------------------------------------------------
// Jira (site URL = <fixture>/jira)

function jiraIssueJson(i: JiraIssue) {
  return { key: i.key, fields: { summary: i.summary, status: { name: i.status, statusCategory: { key: "indeterminate" } }, duedate: i.duedate, priority: { name: i.priority }, assignee: { displayName: "Alex" }, project: { key: i.key.split("-")[0] } } };
}

function mountJira(fx: FixtureServer, s: () => ScenarioState) {
  const P = "/jira/rest/api/3";
  mount(fx, "GET", `${P}/myself`, authed(() => json({ accountId: "acc-alex", displayName: "Alex", emailAddress: s().selfEmail })));
  mount(fx, "GET", `${P}/search/jql`, authed((req) => {
    const jql = req.query.get("jql") ?? "";
    const soon = localDate(Date.now() + 7 * 24 * HOUR);
    let issues = s().jira.issues.filter((i) => (jql.startsWith("reporter") ? i.reporterIsMe : true));
    if (jql.includes("duedate <= 7d")) issues = issues.filter((i) => i.duedate && i.duedate <= soon);
    return json({ issues: issues.map(jiraIssueJson), isLast: true });
  }));
  mount(fx, "POST", `${P}/issue/:key/comment`, authed((req, [key]) => {
    const b = req.body as { body: unknown; properties?: Array<{ key: string; value: unknown }> };
    const c = { id: id(s()), body: b.body, properties: b.properties ?? [] };
    s().jira.comments.set(key!, [...(s().jira.comments.get(key!) ?? []), c]);
    return json({ id: c.id, body: c.body }, 201);
  }));
  mount(fx, "GET", `${P}/issue/:key/comment/:id`, authed((req, [key, cid]) => {
    const c = (s().jira.comments.get(key!) ?? []).find((x) => x.id === cid);
    if (!c) return json({ errorMessages: ["Not found"] }, 404);
    return json(req.query.get("expand") === "properties" ? c : { id: c.id, body: c.body });
  }));
  mount(fx, "GET", `${P}/issue/:key/comment`, authed((req, [key]) => {
    const all = s().jira.comments.get(key!) ?? [];
    const startAt = Number(req.query.get("startAt") ?? 0);
    const max = Number(req.query.get("maxResults") ?? 50);
    return json({ startAt, maxResults: max, total: all.length, comments: all.slice(startAt, startAt + max) });
  }));
}

// ---------------------------------------------------------------------------
// Confluence (site URL = <fixture>/confluence)

function mountConfluence(fx: FixtureServer, s: () => ScenarioState) {
  const P = "/confluence/wiki";
  mount(fx, "GET", `${P}/rest/api/user/current`, authed(() => json({ type: "known", accountId: "acc-alex", displayName: "Alex", email: s().selfEmail })));
  mount(fx, "GET", `${P}/rest/api/search`, authed((req) => {
    const cql = req.query.get("cql") ?? "";
    const pages = s().confluence.pages.filter((p) => (cql.startsWith("mention") ? p.mentionsMe : cql.startsWith("contributor") ? true : cql.includes(`"${p.space}"`)));
    const results = pages.map((p) => ({ content: { id: p.id, type: "page", title: p.title, version: { number: p.version, by: { displayName: "Mia" } }, space: { key: p.space, name: p.space }, _links: { webui: `/spaces/${p.space}/pages/${p.id}` } }, title: p.title, excerpt: `${p.title} excerpt`, lastModified: iso(Date.now() - HOUR) }));
    return json({ results, start: 0, limit: 50, size: results.length, _links: { base: "https://example.atlassian.net/wiki", context: "/wiki" } });
  }));
  mount(fx, "POST", `${P}/api/v2/footer-comments`, authed((req) => {
    const b = req.body as { pageId: string; body: { value: string } };
    const c = { id: id(s()), pageId: b.pageId, body: { storage: { value: b.body.value } }, _links: { webui: `/spaces/ENG/pages/${b.pageId}?focusedCommentId=${s().nextId}` } };
    s().confluence.comments.push(c);
    return json(c);
  }));
  mount(fx, "GET", `${P}/api/v2/footer-comments/:id`, authed((_req, [cid]) => {
    const c = s().confluence.comments.find((x) => x.id === cid);
    return c ? json(c) : json({ message: "Not found" }, 404);
  }));
  mount(fx, "POST", `${P}/api/v2/footer-comments/:id/properties`, authed((req, [cid]) => {
    s().confluence.properties.set(cid!, [...(s().confluence.properties.get(cid!) ?? []), req.body as { key: string; value: unknown }]);
    return json(req.body);
  }));
  mount(fx, "GET", `${P}/api/v2/footer-comments/:id/properties`, authed((_req, [cid]) => json({ results: s().confluence.properties.get(cid!) ?? [], _links: {} })));
  mount(fx, "GET", `${P}/api/v2/pages/:id/footer-comments`, authed((_req, [pid]) => json({ results: s().confluence.comments.filter((c) => c.pageId === pid), _links: {} })));
}

// ---------------------------------------------------------------------------
// Slack (slack.com/api)

function mountSlack(fx: FixtureServer, s: () => ScenarioState) {
  const P = FIXTURE_PREFIX["https://slack.com/api"];
  const ok = (data: Record<string, unknown>) => json({ ok: true, ...data });
  const slackAuthed = (h: Handler): Handler => (req, p) => (req.headers.authorization ? h(req, p) : json({ ok: false, error: "not_authed" }));
  const history = (channel: string) => s().slack.ims.get(channel) ?? s().slack.channels.get(channel);
  mount(fx, "POST", `${P}/auth.test`, slackAuthed(() => ok({ user_id: s().slack.selfId, user: "alex", team: "Acme", url: "https://acme.slack.com/" })));
  mount(fx, "GET", `${P}/conversations.list`, slackAuthed(() => ok({ channels: [...s().slack.ims.keys()].map((cid) => ({ id: cid, is_im: true })), response_metadata: { next_cursor: "" } })));
  mount(fx, "GET", `${P}/conversations.history`, slackAuthed((req) => {
    const msgs = history(req.query.get("channel") ?? "");
    if (!msgs) return json({ ok: false, error: "channel_not_found" });
    const latest = req.query.get("latest");
    const withMeta = req.query.get("include_all_metadata") === "true";
    const top = [...msgs].filter((m) => !m.thread_ts || m.thread_ts === m.ts).sort((a, b) => Number(b.ts) - Number(a.ts));
    const picked = latest ? top.filter((m) => Number(m.ts) <= Number(latest)).slice(0, Number(req.query.get("limit") ?? 100)) : top;
    return ok({ messages: picked.map((m) => (withMeta ? m : { ...m, metadata: undefined })), has_more: false });
  }));
  mount(fx, "GET", `${P}/conversations.replies`, slackAuthed((req) => {
    const msgs = history(req.query.get("channel") ?? "");
    if (!msgs) return json({ ok: false, error: "channel_not_found" });
    const root = req.query.get("ts");
    return ok({ messages: msgs.filter((m) => m.ts === root || m.thread_ts === root), has_more: false });
  }));
  mount(fx, "GET", `${P}/search.messages`, slackAuthed(() => ok({ messages: { matches: s().slack.mentions.map((m) => ({ ...m, channel: { id: m.channel, name: "general" } })), pagination: { page: 1, page_count: 1 } } })));
  mount(fx, "POST", `${P}/chat.postMessage`, slackAuthed((req) => {
    const b = req.body as { channel: string; text: string; thread_ts?: string; metadata?: unknown };
    const list = history(b.channel);
    if (!list) return json({ ok: false, error: "channel_not_found" });
    const m: SlackMessage = { ts: slackTs(Date.now(), ++s().nextId % 1_000_000), user: s().slack.selfId, text: b.text, ...(b.thread_ts ? { thread_ts: b.thread_ts } : {}), ...(b.metadata ? { metadata: b.metadata } : {}) };
    list.push(m);
    return ok({ channel: b.channel, ts: m.ts, message: m });
  }));
}

// ---------------------------------------------------------------------------
// Google OAuth, Gmail and Calendar

function mountGoogleOAuth(fx: FixtureServer, s: () => ScenarioState) {
  mount(fx, "GET", `${FIXTURE_PREFIX["https://accounts.google.com"]}/o/oauth2/v2/auth`, (req) => {
    const redirect = req.query.get("redirect_uri");
    if (!redirect) return json({ error: "invalid_request" }, 400);
    const to = new URL(redirect);
    to.searchParams.set("code", "fixture-code");
    to.searchParams.set("state", req.query.get("state") ?? "");
    return { status: 302, headers: { location: to.toString() }, text: "" };
  });
  mount(fx, "POST", `${FIXTURE_PREFIX["https://oauth2.googleapis.com"]}/token`, (req) => {
    const f = req.body as Record<string, string>;
    const g = s().google;
    const issue = () => {
      g.issued++;
      g.accessToken = `ya29.fixture-access-${g.issued}`;
      return { access_token: g.accessToken, expires_in: 3599, token_type: "Bearer", scope: g.grantedScopes };
    };
    if (f.grant_type === "authorization_code") return f.code === "fixture-code" && f.code_verifier ? json({ ...issue(), refresh_token: g.refreshToken }) : json({ error: "invalid_grant" }, 400);
    if (f.grant_type === "refresh_token") return !g.revoked && f.refresh_token === g.refreshToken ? json(issue()) : json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, 400);
    return json({ error: "unsupported_grant_type" }, 400);
  });
}

const googleAuthed = (s: () => ScenarioState, h: Handler): Handler => (req, p) => (req.headers.authorization === `Bearer ${s().google.accessToken}` ? h(req, p) : json({ error: { code: 401, message: "Invalid Credentials" } }, 401));

function gmailMessageJson(m: GmailMessage, threadId: string) {
  return { id: m.id, threadId, labelIds: m.labels, snippet: `${m.subject} …`, internalDate: String(m.at), payload: { headers: [{ name: "From", value: m.from }, { name: "Subject", value: m.subject }, { name: "Date", value: new Date(m.at).toUTCString() }, { name: "Message-ID", value: `<${m.id}@mail.example>` }] } };
}

function parseRawHeaders(raw: string): Array<{ name: string; value: string }> {
  const text = Buffer.from(raw, "base64url").toString("utf8");
  return text.split("\r\n\r\n")[0]!.split("\r\n").map((l) => ({ name: l.slice(0, l.indexOf(":")), value: l.slice(l.indexOf(":") + 1).trim() }));
}

function mountGmail(fx: FixtureServer, s: () => ScenarioState) {
  const P = `${FIXTURE_PREFIX["https://gmail.googleapis.com"]}/gmail/v1/users/me`;
  const draftJson = (d: ScenarioState["gmail"]["drafts"][number]) => ({ id: d.id, message: { id: d.messageId, threadId: d.threadId, payload: { headers: d.headers } } });
  mount(fx, "GET", `${P}/profile`, googleAuthed(s, () => json({ emailAddress: s().selfEmail, messagesTotal: 42 })));
  mount(fx, "GET", `${P}/threads`, googleAuthed(s, () => json({ threads: [...s().gmail.threads.keys()].map((tid) => ({ id: tid })), resultSizeEstimate: s().gmail.threads.size })));
  mount(fx, "GET", `${P}/threads/:id`, googleAuthed(s, (_req, [tid]) => {
    const t = s().gmail.threads.get(tid!);
    return t ? json({ id: tid, historyId: String(Date.now()), messages: t.map((m) => gmailMessageJson(m, tid!)) }) : json({ error: { message: "Not Found" } }, 404);
  }));
  mount(fx, "POST", `${P}/drafts`, googleAuthed(s, (req) => {
    if (!s().google.grantedScopes.includes(GMAIL_COMPOSE)) return json({ error: { code: 403, message: "Request had insufficient authentication scopes." } }, 403);
    const b = req.body as { message: { raw: string; threadId?: string } };
    const d = { id: `r-${id(s())}`, messageId: `m-${s().nextId}`, threadId: b.message.threadId ?? `thr-${s().nextId}`, headers: parseRawHeaders(b.message.raw) };
    s().gmail.drafts.push(d);
    return json({ id: d.id, message: { id: d.messageId, threadId: d.threadId, labelIds: ["DRAFT"] } });
  }));
  mount(fx, "GET", `${P}/drafts`, googleAuthed(s, () => json({ drafts: s().gmail.drafts.map((d) => ({ id: d.id, message: { id: d.messageId, threadId: d.threadId } })) })));
  mount(fx, "GET", `${P}/drafts/:id`, googleAuthed(s, (_req, [did]) => {
    const d = s().gmail.drafts.find((x) => x.id === did);
    return d ? json(draftJson(d)) : json({ error: { message: "Not Found" } }, 404);
  }));
  mount(fx, "GET", `${P}/messages/:id`, googleAuthed(s, (_req, [mid]) => {
    const d = s().gmail.drafts.find((x) => x.messageId === mid);
    return d ? json(draftJson(d).message) : json({ error: { message: "Not Found" } }, 404);
  }));
}

function mountCalendar(fx: FixtureServer, s: () => ScenarioState) {
  const P = `${FIXTURE_PREFIX["https://www.googleapis.com"]}/calendar/v3`;
  mount(fx, "GET", `${P}/users/me/calendarList`, googleAuthed(s, () => json({ items: [{ id: s().selfEmail, primary: true, summary: s().selfEmail }] })));
  mount(fx, "GET", `${P}/calendars/primary`, googleAuthed(s, () => json({ id: s().selfEmail, summary: s().selfEmail })));
  mount(fx, "GET", `${P}/calendars/primary/events`, googleAuthed(s, (req) => {
    const min = Date.parse(req.query.get("timeMin") ?? "");
    const max = Date.parse(req.query.get("timeMax") ?? "");
    const inRange = (e: CalendarEvent) => {
      const start = Date.parse(e.start.dateTime ?? `${e.start.date}T00:00:00`);
      const end = Date.parse(e.end.dateTime ?? `${e.end.date}T00:00:00`);
      return (!Number.isFinite(min) || end > min) && (!Number.isFinite(max) || start < max);
    };
    const items = s().gcal.events.filter(inRange).map((e) => ({ status: "confirmed", htmlLink: `https://calendar.google.com/event?eid=${e.id}`, organizer: { email: "mia@client.example" }, ...e }));
    return json({ kind: "calendar#events", items });
  }));
}

/**
 * Mount realistic happy-path routes for every service on the fixture server.
 * Routes read `scenarioState` on every request, so mutations are visible to
 * the next sync without re-installing.
 */
export function installScenarios(fx: FixtureServer, opts: { selfEmail?: string } = {}): ScenarioState {
  scenarioState = createScenarioState(opts);
  const s = () => scenarioState;
  mountGithub(fx, s);
  mountJira(fx, s);
  mountConfluence(fx, s);
  mountSlack(fx, s);
  mountGoogleOAuth(fx, s);
  mountGmail(fx, s);
  mountCalendar(fx, s);
  return scenarioState;
}

/** Settings an E2E test gives Jira/Confluence so their site URL points at the fixture. */
export function atlassianSiteUrls(fx: FixtureServer): { jira: string; confluence: string } {
  return { jira: `${fx.url}/jira`, confluence: `${fx.url}/confluence` };
}
