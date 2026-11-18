/**
 * TEST-ONLY happy-path scenarios for every remote service Attache talks to.
 * GitHub is emulated as REST under /github; Jira and Confluence through the
 * Atlassian MCP fixture (atlassian-mcp.ts); Slack, Gmail and Google Calendar
 * as claude.ai connector tools answered for fake-claude.mjs
 * (claude-connectors.ts). End-to-end tests mutate `scenarioState` (push a new
 * PR head, make a Jira item overdue) and re-sync. Nothing here is live evidence.
 */
import type { FixtureRequest, FixtureResponse, FixtureServer } from "./fixture-server.ts";
import { FIXTURE_PREFIX } from "../../src/connectors/test-endpoints.ts";
import { executeOps, mountAtlassianMcp, type AtlassianFixture } from "./atlassian-mcp.ts";
import { jsonAnswer, mountClaude, onTool, slackHistoryAnswer, slackProfileAnswer, slackSearchAnswer, slackSearchInvalid, type ClaudeFixture, type SlackFixtureMessage } from "./claude-connectors.ts";

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
  files: Array<{ filename: string; status: string; additions: number; deletions: number; patch: string }>;
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
  /** The call to join, as Google lists a Meet or other conference link. */
  conferenceUrl?: string;
}

export interface ScenarioState {
  selfEmail: string;
  github: { login: string; prs: GithubPr[]; comments: Map<string, Array<{ id: number; body: string; html_url: string }>> };
  jira: { issues: JiraIssue[]; comments: Map<string, Array<{ id: string; body: string; author: { accountId: string } }>> };
  confluence: { pages: ConfluencePage[]; comments: Array<{ id: string; pageId: string; body: { storage: { value: string } }; version: { authorId: string } }> };
  slack: { selfId: string; messages: SlackFixtureMessage[] };
  gmail: { threads: Map<string, GmailMessage[]>; drafts: Array<{ id: string; threadId: string; body: string }> };
  gcal: { events: CalendarEvent[] };
  /** GitHub tokens revoked since they were saved: GitHub answers 401 to them, as it does after the owner revokes a token. */
  revokedGithubTokens: string[];
  nextId: number;
}

/** The Atlassian site the scenarios answer for; any connection must use this site URL. */
export const ATLASSIAN_SITE = "https://example.atlassian.net";
export const ATLASSIAN_TOKEN = "ATATT3xFfGF0scenario-token";

const HOUR = 3_600_000;

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
  const sm = (channel: string, user: string, at: number, text: string, extra: Partial<SlackFixtureMessage> = {}): SlackFixtureMessage => ({ channel, user, userName: user === "U0SELF" ? "Alex" : user === "U0MIA" ? "Mia Jensen" : "Bob", ts: slackTs(at), text, ...extra });
  return {
    selfEmail,
    github: {
      login: "alex",
      prs: [
        { repo: "acme/web", number: 42, title: "Add checkout retry", author: "mia", headSha: "a1b2c3", draft: false, body: "Retries failed payments once.", files: [{ filename: "src/checkout/retry.ts", status: "added", additions: 24, deletions: 0, patch: "+export async function retryOnce() {}" }] },
        { repo: "acme/api", number: 7, title: "Rate limit search", author: "bob", headSha: "d4e5f6", draft: false, body: "Adds a token bucket.", files: [{ filename: "src/search/limit.ts", status: "added", additions: 31, deletions: 0, patch: "+export class TokenBucket {}" }, { filename: "src/search/route.ts", status: "modified", additions: 3, deletions: 1, patch: "+limit.take()" }] },
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
    },
    slack: {
      selfId: "U0SELF",
      messages: [
        sm("D0000001", "U0MIA", now - HOUR, "Can you look at the checkout PR today?"),
        sm("D0000002", "U0SELF", now - 2 * HOUR, "Sent it over."),
        sm("D0000002", "U0BOB", now - 3 * HOUR, "Got the numbers?"),
        sm("C0000001", "U0BOB", now - 4 * HOUR, "Standup moved to 10:30", { channelName: "general" }),
        sm("C0000001", "U0MIA", now - 5 * HOUR, "<@U0SELF|Alex> can you confirm the release date?", { channelName: "general" }),
      ],
    },
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
    revokedGithubTokens: [],
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
  const revoked = (req: FixtureRequest) => s().revokedGithubTokens.some((t) => req.headers.authorization?.includes(t));
  const authed = (h: Handler): Handler => (req, p) => (req.headers.authorization && !revoked(req) ? h(req, p) : unauthorized);
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
  mount(fx, "GET", `${P}/repos/:owner/:repo/pulls/:n/files`, authed((_req, [o, r, n]) => {
    const pr = s().github.prs.find((p) => p.repo === `${o}/${r}` && p.number === Number(n));
    return pr ? json(pr.files) : json({ message: "Not Found" }, 404);
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
// Jira and Confluence (Atlassian Rovo MCP server)

function jiraIssueJson(i: JiraIssue) {
  return { key: i.key, fields: { summary: i.summary, status: { name: i.status, statusCategory: { key: "indeterminate" } }, duedate: i.duedate, priority: { name: i.priority }, assignee: { displayName: "Alex" }, project: { key: i.key.split("-")[0] } } };
}

function mountAtlassian(fx: FixtureServer, s: () => ScenarioState): AtlassianFixture {
  const atl = mountAtlassianMcp(fx);
  atl.apiTokens.add(`${s().selfEmail}:${ATLASSIAN_TOKEN}`);
  atl.tools.set("atlassianUserInfo", () => ({ account_id: "acc-alex", email: s().selfEmail, name: "Alex" }));
  atl.tools.set("getAccessibleAtlassianResources", () => [{ id: "cloud-example", url: ATLASSIAN_SITE, name: "Example" }]);
  atl.tools.set("searchJiraIssuesUsingJql", (args) => {
    const jql = String(args.jql ?? "");
    const soon = localDate(Date.now() + 7 * 24 * HOUR);
    let issues = s().jira.issues.filter((i) => (jql.startsWith("reporter") ? i.reporterIsMe : true));
    if (jql.includes("duedate <= 7d")) issues = issues.filter((i) => i.duedate && i.duedate <= soon);
    return { issues: issues.map(jiraIssueJson), isLast: true };
  });
  atl.tools.set("addOrEditJiraIssueComment", (args) => {
    const key = String(args.issueIdOrKey);
    const c = { id: String(++s().nextId), body: String(args.commentBody ?? ""), author: { accountId: "acc-alex" } };
    s().jira.comments.set(key, [...(s().jira.comments.get(key) ?? []), c]);
    return { commentId: c.id, body: c.body, appliedContentFormat: "markdown" };
  });
  atl.tools.set("searchConfluence", (args) => {
    const cql = String(args.cql ?? "");
    const pages = s().confluence.pages.filter((p) => (cql.startsWith("mention") ? p.mentionsMe : cql.startsWith("contributor") ? true : cql.includes(`"${p.space}"`)));
    const results = pages.map((p) => ({ content: { id: p.id, type: "page", title: p.title, version: { number: p.version, by: { displayName: "Mia" } }, space: { key: p.space, name: p.space }, _links: { webui: `/spaces/${p.space}/pages/${p.id}` } }, excerpt: `${p.title} excerpt`, lastModified: iso(Date.now() - HOUR) }));
    return { results };
  });
  executeOps(atl, {
    listJiraIssueComments: (inputs) => {
      const all = s().jira.comments.get(String(inputs.issueIdOrKey)) ?? [];
      return { comments: all, total: all.length, startAt: 0 };
    },
    createConfluenceComment: (inputs) => {
      const c = { id: String(++s().nextId), pageId: String(inputs.pageId), body: { storage: { value: String((inputs.body as { value?: string })?.value ?? "") } }, version: { authorId: "acc-alex" }, _links: { webui: `/spaces/ENG/pages/${String(inputs.pageId)}?focusedCommentId=${s().nextId}` } };
      s().confluence.comments.push(c);
      return c;
    },
    listConfluenceComments: (inputs) => ({ results: s().confluence.comments.filter((c) => c.pageId === String(inputs.pageId)) }),
  });
  return atl;
}

// ---------------------------------------------------------------------------
// Slack, Gmail and Google Calendar (claude.ai connectors through fake-claude.mjs)

const SLACK = "claude.ai Slack";
const GMAIL = "claude.ai Gmail";
const GCAL = "claude.ai Google Calendar";

function mountSlack(c: ClaudeFixture, s: () => ScenarioState) {
  const newestFirst = (list: SlackFixtureMessage[]) => [...list].sort((a, b) => Number(b.ts) - Number(a.ts));
  const after = (a: Record<string, unknown>) => Number(a.after ?? 0);
  onTool(c, SLACK, "slack_read_user_profile", () => slackProfileAnswer(s().slack.selfId, s().selfEmail));
  onTool(c, SLACK, "slack_search_public_and_private", (a) => {
    const invalid = slackSearchInvalid(a);
    if (invalid) return invalid;
    const im = a.channel_types === "im";
    const keywords = (a.keywords as string[] | undefined) ?? [];
    const hits = s().slack.messages.filter((m) => Number(m.ts) >= after(a) && (im ? m.channel.startsWith("D") : keywords.every((k) => m.text.includes(k.replace(/>$/, "")))));
    return slackSearchAnswer(newestFirst(hits));
  });
  onTool(c, SLACK, "slack_read_channel", (a) => {
    const channel = String(a.channel_id);
    const list = s().slack.messages.filter((m) => m.channel === channel && !m.threadTs && Number(m.ts) >= Number(a.oldest ?? 0));
    return s().slack.messages.some((m) => m.channel === channel) ? slackHistoryAnswer(channel, newestFirst(list)) : { text: "channel_not_found", isError: true };
  });
  onTool(c, SLACK, "slack_read_thread", (a) => {
    const channel = String(a.channel_id);
    return slackHistoryAnswer(channel, newestFirst(s().slack.messages.filter((m) => m.channel === channel && (m.ts === a.message_ts || m.threadTs === a.message_ts))));
  });
  onTool(c, SLACK, "slack_send_message", (a) => {
    const channel = String(a.channel_id);
    if (!s().slack.messages.some((m) => m.channel === channel)) return { text: "channel_not_found", isError: true };
    const m: SlackFixtureMessage = { channel, user: s().slack.selfId, userName: "Alex", ts: slackTs(Date.now(), ++s().nextId % 1_000_000), text: String(a.message), ...(a.thread_ts ? { threadTs: String(a.thread_ts) } : {}) };
    s().slack.messages.push(m);
    return jsonAnswer({ ok: true, message_link: `https://acme.slack.com/archives/${channel}/p${m.ts.replace(".", "")}` });
  });
}

function mountGmail(c: ClaudeFixture, s: () => ScenarioState) {
  const threadJson = (id: string, msgs: GmailMessage[]) => ({ id, viewUrl: `https://mail.google.com/mail/?authuser=${s().selfEmail}#all/${id}`, messages: msgs.map((m) => ({ id: m.id, threadId: id, sender: m.from, subject: m.subject, snippet: `${m.subject} …`, labelIds: m.labels, internalDate: String(m.at), date: iso(m.at) })) });
  // As the connector answers since 2026-11: search results carry no date, labels, snippet or viewUrl and strip dots
  // from addresses; get_thread has the full metadata.
  const undot = (from: string) => from.replace(/([^<\s@]+)@/, (_, local: string) => `${local.replace(/\./g, "")}@`);
  onTool(c, GMAIL, "search_threads", () =>
    jsonAnswer(
      s().gmail.threads.size
        ? { resultCountEstimate: String(s().gmail.threads.size), threads: [...s().gmail.threads].map(([id, msgs]) => ({ id, messageCount: msgs.length, messages: msgs.map((m) => ({ id: m.id, threadId: id, sender: undot(m.from), subject: m.subject })) })) }
        : {},
    ),
  );
  onTool(c, GMAIL, "get_thread", (a) => {
    const msgs = s().gmail.threads.get(String(a.threadId));
    return msgs ? jsonAnswer({ ...threadJson(String(a.threadId), msgs), messageCount: msgs.length }) : { text: "Requested entity was not found. 404", isError: true };
  });
  onTool(c, GMAIL, "create_draft", (a) => {
    const reply = [...s().gmail.threads].find(([, msgs]) => msgs.some((m) => m.id === a.replyToMessageId));
    const d = { id: `r-${++s().nextId}`, threadId: reply?.[0] ?? `thr-${s().nextId}`, body: String(a.body ?? "") };
    s().gmail.drafts.push(d);
    return jsonAnswer({ id: d.id, threadId: d.threadId, viewUrl: `https://mail.google.com/mail/#drafts/${d.id}` });
  });
  onTool(c, GMAIL, "get_draft", (a) => {
    const d = s().gmail.drafts.find((x) => x.id === a.draftId);
    return d ? jsonAnswer({ id: d.id, message: { threadId: d.threadId } }) : { text: "Requested entity was not found. 404", isError: true };
  });
  onTool(c, GMAIL, "list_drafts", () => jsonAnswer({ drafts: s().gmail.drafts.map((d) => ({ id: d.id, threadId: d.threadId, plaintextBody: d.body })) }));
}

function mountCalendar(c: ClaudeFixture, s: () => ScenarioState) {
  onTool(c, GCAL, "list_events", (a) => {
    const min = Date.parse(String(a.startTime ?? ""));
    const max = Date.parse(String(a.endTime ?? ""));
    const inRange = (e: CalendarEvent) => {
      const start = Date.parse(e.start.dateTime ?? `${e.start.date}T00:00:00`);
      const end = Date.parse(e.end.dateTime ?? `${e.end.date}T00:00:00`);
      return (!Number.isFinite(min) || end > min) && (!Number.isFinite(max) || start < max);
    };
    const events = s().gcal.events.filter(inRange).map((e) => ({ status: "confirmed", htmlLink: `https://calendar.google.com/event?eid=${e.id}`, organizer: { email: "mia@client.example" }, ...e }));
    return jsonAnswer({ events, summary: s().selfEmail, timeZone: "Europe/Copenhagen" });
  });
}

/**
 * Mount realistic happy-path answers for every service on the fixture server.
 * Handlers read `scenarioState` on every call, so mutations are visible to the
 * next sync without re-installing.
 */
export function installScenarios(fx: FixtureServer, opts: { selfEmail?: string } = {}): { state: ScenarioState; atlassian: AtlassianFixture; claude: ClaudeFixture } {
  scenarioState = createScenarioState(opts);
  const s = () => scenarioState;
  mountGithub(fx, s);
  const atlassian = mountAtlassian(fx, s);
  const claude = mountClaude(fx, { auth: { loggedIn: true, authMethod: "claude.ai", email: s().selfEmail, orgName: "Example Org" } });
  mountSlack(claude, s);
  mountGmail(claude, s);
  mountCalendar(claude, s);
  return { state: scenarioState, atlassian, claude };
}
