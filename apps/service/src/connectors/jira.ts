/**
 * Jira through the Atlassian Rovo MCP server, reached either through the
 * user's claude.ai connector or Jarvis's own MCP client (atlassian-backend.ts).
 * Reads are JQL searches with cursor pagination; the one write is a comment,
 * verified by reading the issue's comments back.
 */
import type { ConnectorAdapter, AdapterContext, AttentionCandidate, Observation, RefreshResult, ExecuteResult } from "./types.ts";
import { CoverageTracker } from "./types.ts";
import { RemoteError, afterWrite } from "./http.ts";
import { asRemoteError, attemptStartMs, daysBetween, listingNote, listingState, localDateString, recordFailure, sameLooseText } from "./common.ts";
import {
  ATLASSIAN_SECRET_NAMES,
  atlassianAuthMethods,
  atlassianAuthorizeUrl,
  atlassianExchangeCode,
  atlassianScopes,
  atlassianSetupSteps,
  configureAtlassian,
  grantedScopes,
  isAtlassianAuthorized,
  siteUrl,
} from "./atlassian.ts";
import { adfText, authorId, pick, str } from "./atlassian-shapes.ts";
import { atlassianBackend, usesClaude } from "./atlassian-backend.ts";

export interface JiraIssue {
  key: string;
  summary: string;
  status: string | null;
  statusCategory: string | null;
  duedate: string | null;
  priority: string | null;
  assignee: string | null;
  project: string | null;
}

type DueCategory = "overdue" | "due" | "open";

const MAX_PAGES = 5;
const DUE_WINDOW_DAYS = 7;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

const SCOPES = [
  { id: "assigned_open", label: "Open work items assigned to me", jql: "assignee = currentUser() AND statusCategory != Done ORDER BY duedate ASC", attention: true },
  { id: "due_soon", label: "My work items due within 7 days", jql: "assignee = currentUser() AND statusCategory != Done AND duedate <= 7d ORDER BY duedate ASC", attention: true },
  { id: "reported_open", label: "Open work items I reported", jql: "reporter = currentUser() AND statusCategory != Done ORDER BY updated DESC", attention: false },
];

/** Accepts both the REST-shaped issue and a flattened "compact" view; null when it has no key. */
export function normalizeIssue(raw: unknown): JiraIssue | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const f = (r.fields && typeof r.fields === "object" ? r.fields : r) as Record<string, unknown>;
  const key = str(r.key) ?? str(r.issueKey);
  if (!key || !ISSUE_KEY.test(key)) return null;
  const status = f.status;
  return {
    key,
    summary: str(f.summary) ?? "",
    status: typeof status === "string" ? status : str(pick(status, "name")),
    statusCategory: str(pick(status, "statusCategory", "key")) ?? str(f.statusCategory),
    duedate: str(f.duedate) ?? str(f.dueDate),
    priority: typeof f.priority === "string" ? f.priority : str(pick(f.priority, "name")),
    assignee: typeof f.assignee === "string" ? f.assignee : str(pick(f.assignee, "displayName")),
    project: typeof f.project === "string" ? f.project : str(pick(f.project, "key")),
  };
}

export function dueCategory(duedate: string | null | undefined, today: string): DueCategory {
  if (!duedate) return "open";
  const days = daysBetween(today, duedate);
  if (days < 0) return "overdue";
  return days <= DUE_WINDOW_DAYS ? "due" : "open";
}

const isHighPriority = (issue: JiraIssue) => /highest|high|blocker|critical/i.test(issue.priority ?? "");

function attentionFor(issue: JiraIssue, category: DueCategory, today: string, url: string): AttentionCandidate | undefined {
  if (category === "open") return undefined;
  const summary = issue.summary || "(no summary)";
  const due = issue.duedate!;
  const days = daysBetween(today, due);
  const when = category === "overdue" ? `overdue since ${due}` : days === 0 ? "due today" : `due ${due}`;
  const boost = isHighPriority(issue) ? 10 : 0;
  return {
    key: `jira:${issue.key}`,
    kind: category === "overdue" ? "overdue_work_item" : "due_work_item",
    title: `${issue.key} ${category === "overdue" ? "overdue" : when}: ${summary}`,
    summary: `${issue.status ?? "Open"} · ${when}${issue.priority ? ` · ${issue.priority} priority` : ""}`,
    why: category === "overdue" ? "Assigned to you and past its due date." : `Assigned to you and due within ${DUE_WINDOW_DAYS} days.`,
    url,
    dueAt: due,
    priority: category === "overdue" ? 80 + boost : Math.max(40, 70 - days * 4) + boost,
    extraFingerprint: [category],
    draftable: { actionKind: "jira.comment", target: { key: issue.key, url }, context: { summary, status: issue.status, duedate: due } },
  };
}

function toObservation(ctx: AdapterContext, issue: JiraIssue, withAttention: boolean, today: string): Observation {
  const url = `${siteUrl(ctx)}/browse/${issue.key}`;
  const category = dueCategory(issue.duedate, today);
  const attention = withAttention ? attentionFor(issue, category, today, url) : undefined;
  return {
    kind: "jira_work_item",
    externalId: issue.key,
    title: `${issue.key}: ${issue.summary}`,
    url,
    data: { ...issue, category },
    fingerprintParts: [issue.summary, issue.status ?? "", issue.duedate, issue.priority, category],
    ...(attention ? { attention } : {}),
  };
}

function targetKey(target: Record<string, unknown>): string {
  const key = String(target.key ?? "");
  if (!ISSUE_KEY.test(key)) throw new RemoteError("Invalid Jira work item key", "error");
  return key;
}

const commentUrl = (ctx: AdapterContext, key: string, id: string) => `${siteUrl(ctx)}/browse/${key}?focusedCommentId=${id}`;

/**
 * A comment posted by this action: my own, created after the attempt started, with the same text once
 * formatting is ignored (Jira stores Markdown as ADF). The MCP tool cannot attach hidden properties.
 */
function isOurComment(c: Record<string, unknown>, body: string, selfId: string, fromMs: number): boolean {
  const created = Date.parse(str(c.created) ?? "");
  if (Number.isFinite(created) && created < fromMs) return false;
  return authorId(c) === selfId && sameLooseText(typeof c.body === "string" ? c.body : adfText(c.body), body);
}

export const jiraAdapter: ConnectorAdapter = {
  kind: "jira",
  secretNames: ATLASSIAN_SECRET_NAMES,
  definition: {
    kind: "jira",
    label: "Jira",
    description: "Work items assigned to you, what is due soon or overdue, and optionally what you reported.",
    authMethods: atlassianAuthMethods("jira"),
    scopes: SCOPES.map((s) => ({ id: s.id, label: s.label, default: s.id !== "reported_open" })),
    writeActions: [{ id: "jira.comment", label: "Add a comment to a work item" }],
    setupHelp: "Jarvis connects to Jira through the Atlassian Rovo MCP server with your own permissions, read-only unless you authorise commenting. Comments are only posted after you approve each draft.",
    unavoidableSteps: atlassianSetupSteps(),
  },

  configure: (ctx, fields) => configureAtlassian(ctx, fields),
  oauthScopes: (includeWrite) => atlassianScopes("jira", includeWrite),
  isAuthorized: isAtlassianAuthorized,

  async authorizeUrl(ctx, p) {
    return atlassianAuthorizeUrl(ctx, p);
  },

  async completeAuthorization(ctx, p) {
    const { grantedScopes: scope } = await atlassianExchangeCode(ctx, p);
    return { account: null, settings: { ...ctx.connection.settings, grantedScopes: scope } };
  },

  async test(ctx) {
    try {
      const b = atlassianBackend(ctx);
      const who = usesClaude(ctx) ? await ctx.claude.account(ctx.signal) : null;
      const me = await b.identify();
      const probe = (await atlassianBackend({ ...ctx, connection: { ...ctx.connection, settings: { ...ctx.connection.settings, cloudId: me.cloudId } } }).searchJql([{ id: "probe", query: "assignee = currentUser() ORDER BY updated DESC" }], { maxPages: 1, pageSize: 1 })).get("probe")!;
      if (probe.error) throw probe.error;
      const via = usesClaude(ctx) ? ` through claude.ai${who?.email ? ` (${who.email})` : ""}` : "";
      return { ok: true, state: "complete", account: me.account, message: `Signed in as ${me.account ?? "unknown"} on ${me.siteName ?? siteUrl(ctx)}${via}`, grantedScopes: grantedScopes(ctx), settings: { cloudId: me.cloudId } };
    } catch (e) {
      const err = asRemoteError(e);
      return { ok: false, state: err.state, account: null, message: err.message };
    }
  },

  async refresh(ctx): Promise<RefreshResult> {
    const cov = new CoverageTracker();
    const observations: Observation[] = [];
    const seen = new Set<string>();
    const today = localDateString(ctx.now());
    const selected = SCOPES.filter((s) => ctx.connection.readScopes.includes(s.id));
    if (!selected.length) return { coverage: cov.finish(), observations };
    // Every scope's first page goes in one round (one Claude Code session on the claude.ai path).
    const results = await atlassianBackend(ctx).searchJql(selected.map((s) => ({ id: s.id, query: s.jql })), { maxPages: MAX_PAGES });
    for (const s of selected) {
      const r = results.get(s.id)!;
      if (r.error && r.pages === 0) {
        recordFailure(cov, s.label, r.error);
        continue;
      }
      const issues = r.items.map(normalizeIssue);
      const unreadable = issues.filter((i) => !i).length;
      const valid = issues.filter((i): i is JiraIssue => !!i);
      const extra = [...r.notes, ...(unreadable ? [`${unreadable} result(s) had no readable work item key`] : [])];
      cov.add(s.label, unreadable || r.notes.length ? "partial" : listingState({ items: valid, complete: r.complete }), valid.length, r.pages, listingNote({ complete: r.complete, error: r.error }, MAX_PAGES, extra));
      for (const issue of valid) {
        if (seen.has(issue.key)) continue;
        seen.add(issue.key);
        observations.push(toObservation(ctx, issue, s.attention, today));
      }
    }
    return { coverage: cov.finish(), observations };
  },

  async execute(ctx, action): Promise<ExecuteResult> {
    if (action.kind !== "jira.comment") throw new RemoteError(`Unsupported action ${action.kind}`, "error");
    const key = targetKey(action.target);
    const text = String(action.payload.body ?? "").trim();
    if (!text) throw new RemoteError("The comment is empty", "error");
    const b = atlassianBackend(ctx);
    const res = await b.addJiraComment(key, text);
    const id = str(res?.commentId) ?? str(res?.id) ?? str(pick(res, "comment", "id"));
    if (!id) throw new RemoteError("Jira accepted the comment but returned no comment id; it will be looked up before any retry", "error");
    const check = await afterWrite(() => b.listJiraComments(key));
    const verified = !!check?.items.some((c) => String(c.id) === id);
    return { verified, remoteId: id, url: commentUrl(ctx, key, id), detail: { key } };
  },

  async findEffect(ctx, action) {
    const key = targetKey(action.target);
    const body = String(action.payload.body ?? "");
    const b = atlassianBackend(ctx);
    const selfId = await b.selfAccountId();
    const r = await b.listJiraComments(key);
    const fromMs = attemptStartMs(action.since, 0);
    const found = r.items.find((c) => isOurComment(c, body, selfId, fromMs));
    if (found) return { verified: true, remoteId: String(found.id), url: commentUrl(ctx, key, String(found.id)), detail: { key, recovered: true } };
    if (!r.complete) throw new RemoteError("Could not read all comments to check for an earlier attempt", "partial");
    return null;
  },
};
