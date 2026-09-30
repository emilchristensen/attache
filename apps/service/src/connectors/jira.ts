import type { ConnectorAdapter, AdapterContext, AttentionCandidate, Observation, SyncResult, ExecuteResult } from "./types.ts";
import { CoverageTracker } from "./types.ts";
import { RemoteError, afterWrite, paginate } from "./http.ts";
import { asRemoteError, basicAuth, daysBetween, listingNote, listingState, localDateString, normalizeSiteUrl, recordFailure, stringSetting } from "./common.ts";

interface JiraIssue {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    duedate?: string | null;
    priority?: { name?: string } | null;
    assignee?: { displayName?: string; emailAddress?: string } | null;
    project?: { key?: string; name?: string };
  };
}

interface JiraComment {
  id: string;
  properties?: Array<{ key: string; value: unknown }>;
}

type DueCategory = "overdue" | "due" | "open";

const MAX_PAGES = 5;
const DUE_WINDOW_DAYS = 7;
const FIELDS = "summary,status,duedate,priority,assignee,project";
const PROPERTY_KEY = "jarvis";
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;

const SCOPES = [
  { id: "assigned_open", label: "Open work items assigned to me", jql: "assignee = currentUser() AND statusCategory != Done ORDER BY duedate ASC", attention: true },
  { id: "due_soon", label: "My work items due within 7 days", jql: "assignee = currentUser() AND statusCategory != Done AND duedate <= 7d ORDER BY duedate ASC", attention: true },
  { id: "reported_open", label: "Open work items I reported", jql: "reporter = currentUser() AND statusCategory != Done ORDER BY updated DESC", attention: false },
];

function siteSetting(ctx: AdapterContext): string {
  const raw = stringSetting(ctx.connection.settings, "siteUrl");
  if (!raw) throw new RemoteError("Jira site URL is not configured", "not_configured");
  return raw.replace(/\/$/, "");
}

function base(ctx: AdapterContext): string {
  return ctx.endpoint(siteSetting(ctx)).replace(/\/$/, "");
}

async function headers(ctx: AdapterContext): Promise<Record<string, string>> {
  const token = await ctx.secret("apiToken");
  const email = stringSetting(ctx.connection.settings, "email");
  if (!token || !email) throw new RemoteError("No Jira API token stored", "unauthorized");
  return { authorization: basicAuth(email, token) };
}

async function searchJql(ctx: AdapterContext, jql: string) {
  const h = await headers(ctx);
  return paginate<JiraIssue>(
    async (cursor) => {
      const qs = new URLSearchParams({ jql, fields: FIELDS, maxResults: "50" });
      if (cursor) qs.set("nextPageToken", cursor);
      const res = await ctx.http.request<{ issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean }>({ url: `${base(ctx)}/rest/api/3/search/jql?${qs}`, headers: h });
      const next = res.data.isLast === false && res.data.nextPageToken ? res.data.nextPageToken : null;
      return { items: res.data.issues ?? [], next };
    },
    { maxPages: MAX_PAGES },
  );
}

export function dueCategory(duedate: string | null | undefined, today: string): DueCategory {
  if (!duedate) return "open";
  const days = daysBetween(today, duedate);
  if (days < 0) return "overdue";
  return days <= DUE_WINDOW_DAYS ? "due" : "open";
}

function isHighPriority(issue: JiraIssue): boolean {
  return /highest|high|blocker|critical/i.test(issue.fields.priority?.name ?? "");
}

function attentionFor(issue: JiraIssue, category: DueCategory, today: string, url: string): AttentionCandidate | undefined {
  if (category === "open") return undefined;
  const summary = issue.fields.summary ?? "(no summary)";
  const due = issue.fields.duedate!;
  const days = daysBetween(today, due);
  const when = category === "overdue" ? `overdue since ${due}` : days === 0 ? "due today" : `due ${due}`;
  const boost = isHighPriority(issue) ? 10 : 0;
  return {
    key: `jira:${issue.key}`,
    kind: category === "overdue" ? "overdue_work_item" : "due_work_item",
    title: `${issue.key} ${category === "overdue" ? "overdue" : when}: ${summary}`,
    summary: `${issue.fields.status?.name ?? "Open"} · ${when}${issue.fields.priority?.name ? ` · ${issue.fields.priority.name} priority` : ""}`,
    why: category === "overdue" ? "Assigned to you and past its due date." : `Assigned to you and due within ${DUE_WINDOW_DAYS} days.`,
    url,
    dueAt: due,
    priority: category === "overdue" ? 80 + boost : Math.max(40, 70 - days * 4) + boost,
    extraFingerprint: [category],
    draftable: { actionKind: "jira.comment", target: { key: issue.key, url }, context: { summary, status: issue.fields.status?.name ?? null, duedate: due } },
  };
}

function toObservation(ctx: AdapterContext, issue: JiraIssue, withAttention: boolean, today: string): Observation {
  const f = issue.fields;
  const url = `${siteSetting(ctx)}/browse/${issue.key}`;
  const category = dueCategory(f.duedate, today);
  const attention = withAttention ? attentionFor(issue, category, today, url) : undefined;
  return {
    kind: "jira_work_item",
    externalId: issue.key,
    title: `${issue.key}: ${f.summary ?? ""}`,
    url,
    data: {
      key: issue.key,
      summary: f.summary ?? "",
      status: f.status?.name ?? null,
      statusCategory: f.status?.statusCategory?.key ?? null,
      duedate: f.duedate ?? null,
      priority: f.priority?.name ?? null,
      assignee: f.assignee?.displayName ?? null,
      project: f.project?.key ?? null,
      category,
    },
    fingerprintParts: [f.summary ?? "", f.status?.name ?? "", f.duedate ?? null, f.priority?.name ?? null, category],
    ...(attention ? { attention } : {}),
  };
}

/** Atlassian Document Format for plain text: blank lines split paragraphs, single newlines become hard breaks. */
export function toAdf(text: string) {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return {
    type: "doc",
    version: 1,
    content: paragraphs.map((p) => ({
      type: "paragraph",
      content: p.split("\n").flatMap((line, i) => [...(i > 0 ? [{ type: "hardBreak" }] : []), ...(line ? [{ type: "text", text: line }] : [])]),
    })),
  };
}

function hasMarker(c: JiraComment, effectKey: string): boolean {
  return (c.properties ?? []).some((p) => p.key === PROPERTY_KEY && (p.value as { effect?: unknown } | null)?.effect === effectKey);
}

function targetKey(target: Record<string, unknown>): string {
  const key = String(target.key ?? "");
  if (!ISSUE_KEY.test(key)) throw new RemoteError("Invalid Jira work item key", "error");
  return key;
}

function commentUrl(ctx: AdapterContext, key: string, id: string): string {
  return `${siteSetting(ctx)}/browse/${key}?focusedCommentId=${id}`;
}

export const jiraAdapter: ConnectorAdapter = {
  kind: "jira",
  secretNames: ["apiToken"],
  definition: {
    kind: "jira",
    label: "Jira",
    description: "Work items assigned to you, what is due soon or overdue, and optionally what you reported.",
    authMethods: [
      {
        id: "api-token",
        label: "Atlassian API token",
        fields: [
          { id: "siteUrl", label: "Site URL", secret: false, placeholder: "https://acme.atlassian.net" },
          { id: "email", label: "Atlassian account email", secret: false, placeholder: "you@company.com" },
          { id: "apiToken", label: "API token", secret: true, help: "Create one at id.atlassian.com/manage-profile/security/api-tokens. It acts with your own Jira permissions." },
        ],
      },
    ],
    scopes: SCOPES.map((s) => ({ id: s.id, label: s.label, default: s.id !== "reported_open" })),
    writeActions: [{ id: "jira.comment", label: "Add a comment to a work item" }],
    setupHelp: "Jarvis reads Jira with your API token and your own permissions. Comments are only posted after you approve each draft.",
    unavoidableSteps: ["Create an Atlassian API token at id.atlassian.com/manage-profile/security/api-tokens."],
  },

  async configure(ctx, fields) {
    const siteUrl = normalizeSiteUrl(fields.siteUrl ?? "");
    const email = fields.email?.trim() ?? "";
    const token = fields.apiToken?.trim() ?? "";
    if (!email.includes("@")) throw new RemoteError("Enter the email address of your Atlassian account", "unauthorized");
    if (!token) throw new RemoteError("An API token is required", "unauthorized");
    await ctx.setSecret("apiToken", token);
    return { siteUrl, email, authMethod: "api-token" };
  },

  async test(ctx) {
    try {
      const res = await ctx.http.request<{ displayName?: string; emailAddress?: string; accountId?: string }>({ url: `${base(ctx)}/rest/api/3/myself`, headers: await headers(ctx), retries: 1 });
      const account = res.data.emailAddress || res.data.displayName || res.data.accountId || null;
      return { ok: true, state: "complete", account, message: `Signed in as ${res.data.displayName ?? account ?? "unknown"}` };
    } catch (e) {
      const err = asRemoteError(e);
      return { ok: false, state: err.state, account: null, message: err.message };
    }
  },

  async sync(ctx): Promise<SyncResult> {
    const cov = new CoverageTracker();
    const observations: Observation[] = [];
    const seen = new Set<string>();
    const today = localDateString(ctx.now());
    for (const s of SCOPES) {
      if (!ctx.connection.readScopes.includes(s.id)) continue;
      try {
        const r = await searchJql(ctx, s.jql);
        cov.add(s.label, listingState(r), r.items.length, r.pages, listingNote(r, MAX_PAGES));
        for (const issue of r.items) {
          if (seen.has(issue.key)) continue;
          seen.add(issue.key);
          observations.push(toObservation(ctx, issue, s.attention, today));
        }
      } catch (e) {
        recordFailure(cov, s.label, e);
      }
    }
    return { coverage: cov.finish(), observations };
  },

  async execute(ctx, action): Promise<ExecuteResult> {
    if (action.kind !== "jira.comment") throw new RemoteError(`Unsupported action ${action.kind}`, "error");
    const key = targetKey(action.target);
    const text = String(action.payload.body ?? "").trim();
    if (!text) throw new RemoteError("The comment is empty", "error");
    const body = { body: toAdf(text), properties: [{ key: PROPERTY_KEY, value: { effect: action.effectKey } }] };
    const res = await ctx.http.request<{ id: string }>({ method: "POST", url: `${base(ctx)}/rest/api/3/issue/${key}/comment`, headers: await headers(ctx), body, retries: 0 });
    const id = String(res.data.id);
    const check = await afterWrite(async () => ctx.http.request<JiraComment>({ url: `${base(ctx)}/rest/api/3/issue/${key}/comment/${id}?expand=properties`, headers: await headers(ctx) }));
    const verified = !!check && String(check.data.id) === id && hasMarker(check.data, action.effectKey);
    return { verified, remoteId: id, url: commentUrl(ctx, key, id), detail: { key } };
  },

  async findEffect(ctx, action) {
    const key = targetKey(action.target);
    const h = await headers(ctx);
    const r = await paginate<JiraComment>(
      async (cursor) => {
        const startAt = Number(cursor ?? 0);
        const res = await ctx.http.request<{ comments?: JiraComment[]; total?: number }>({ url: `${base(ctx)}/rest/api/3/issue/${key}/comment?expand=properties&startAt=${startAt}&maxResults=100`, headers: h });
        const comments = res.data.comments ?? [];
        const nextAt = startAt + comments.length;
        return { items: comments, next: comments.length && nextAt < (res.data.total ?? 0) ? String(nextAt) : null };
      },
      { maxPages: 20 },
    );
    const found = r.items.find((c) => hasMarker(c, action.effectKey));
    if (found) return { verified: true, remoteId: String(found.id), url: commentUrl(ctx, key, String(found.id)), detail: { key, recovered: true } };
    if (!r.complete) throw new RemoteError("Could not read all comments to check for an earlier attempt", "partial");
    return null;
  },
};
