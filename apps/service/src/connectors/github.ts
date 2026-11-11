import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { platformLocations, toolCandidates } from "../platform/locations.ts";
import type { ConnectorAdapter, AdapterContext, Observation, SyncResult } from "./types.ts";
import { CoverageTracker } from "./types.ts";
import { RemoteError, afterWrite, nextLink, paginate } from "./http.ts";

interface SearchItem {
  number: number;
  title: string;
  html_url: string;
  state: string;
  draft?: boolean;
  user?: { login: string };
  repository_url: string;
  created_at: string;
  updated_at: string;
  body?: string | null;
  pull_request?: unknown;
  labels?: Array<{ name: string }>;
}

const MAX_PAGES = 5;
const MARKER = (key: string) => `<!-- jarvis:effect=${key} -->`;

function repoOf(item: SearchItem): string {
  return item.repository_url.replace(/^.*\/repos\//, "");
}

async function ghCliToken(): Promise<string | null> {
  return new Promise((resolve) => {
    // Services started at login often lack the owner's PATH, so the usual install folders come first.
    const candidates = [...toolCandidates(platformLocations(), "gh").filter((p) => existsSync(p)), "gh"];
    const tryNext = (i: number) => {
      if (i >= candidates.length) return resolve(null);
      execFile(candidates[i]!, ["auth", "token"], { timeout: 5000 }, (err, stdout) => {
        if (err || !stdout.trim()) return tryNext(i + 1);
        resolve(stdout.trim());
      });
    };
    tryNext(0);
  });
}

function base(ctx: AdapterContext): string {
  const configured = typeof ctx.connection.settings.apiBaseUrl === "string" && ctx.connection.settings.apiBaseUrl ? String(ctx.connection.settings.apiBaseUrl) : "https://api.github.com";
  return ctx.endpoint(configured).replace(/\/$/, "");
}

async function headers(ctx: AdapterContext): Promise<Record<string, string>> {
  const token = await ctx.secret("token");
  if (!token) throw new RemoteError("No GitHub token stored", "unauthorized");
  return { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
}

async function searchScope(ctx: AdapterContext, q: string) {
  const h = await headers(ctx);
  let incomplete = false;
  const result = await paginate<SearchItem>(
    async (cursor) => {
      const url = cursor ?? `${base(ctx)}/search/issues?q=${encodeURIComponent(q)}&per_page=50&advanced_search=true`;
      const res = await ctx.http.request<{ items: SearchItem[]; incomplete_results?: boolean }>({ url, headers: h });
      if (res.data.incomplete_results) incomplete = true;
      return { items: res.data.items ?? [], next: nextLink(res.headers.get("link")) };
    },
    { maxPages: MAX_PAGES },
  );
  return { ...result, complete: result.complete && !incomplete, incomplete };
}

export const githubAdapter: ConnectorAdapter = {
  kind: "github",
  secretNames: ["token"],
  definition: {
    kind: "github",
    label: "GitHub",
    description: "Pull requests waiting for your review, your open pull requests and assigned issues.",
    authMethods: [
      {
        id: "token",
        label: "Personal access token",
        fields: [
          { id: "token", label: "Token", secret: true, placeholder: "github_pat_… or ghp_…", help: "Create a fine-grained token with read access to Pull requests, Issues and Metadata for the repositories you want. Add Issues: write only if you authorise commenting." },
          { id: "apiBaseUrl", label: "API URL (GitHub Enterprise only)", secret: false, optional: true, placeholder: "https://api.github.com" },
        ],
      },
      { id: "gh-cli", label: "Use my GitHub CLI login", fields: [] },
    ],
    scopes: [
      { id: "review_requests", label: "Pull requests requesting my review", default: true },
      { id: "authored_prs", label: "My open pull requests", default: true },
      { id: "assigned_issues", label: "Issues assigned to me", default: false },
    ],
    writeActions: [{ id: "github.comment", label: "Post a comment on a pull request or issue" }],
    setupHelp: "Jarvis reads with the token you provide. Writes need separate authorisation below and a token with Issues: write.",
    unavoidableSteps: ["Create a personal access token at github.com/settings/tokens (or sign in to the GitHub CLI)."],
  },

  async configure(ctx, fields) {
    let token = fields.token?.trim();
    if (fields.method === "gh-cli") {
      token = (await ghCliToken()) ?? "";
      if (!token) throw new RemoteError("GitHub CLI is not installed or not signed in. Run `gh auth login`, or use a personal access token.", "unauthorized");
    }
    if (!token) throw new RemoteError("A token is required", "unauthorized");
    await ctx.setSecret("token", token);
    return { apiBaseUrl: fields.apiBaseUrl?.trim() || "", authMethod: fields.method === "gh-cli" ? "gh-cli" : "token" };
  },

  async test(ctx) {
    try {
      const res = await ctx.http.request<{ login: string }>({ url: `${base(ctx)}/user`, headers: await headers(ctx), retries: 1 });
      const scopes = (res.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
      return { ok: true, state: "complete", account: res.data.login, message: `Signed in as ${res.data.login}`, grantedScopes: scopes };
    } catch (e) {
      const err = e as RemoteError;
      return { ok: false, state: err.state ?? "error", account: null, message: err.message };
    }
  },

  async sync(ctx): Promise<SyncResult> {
    const cov = new CoverageTracker();
    const observations: Observation[] = [];
    const scopes = ctx.connection.readScopes;
    const queries: Array<{ id: string; label: string; q: string; kind: string }> = [
      { id: "review_requests", label: "PRs requesting my review", q: "is:pr is:open archived:false review-requested:@me", kind: "review_request" },
      { id: "authored_prs", label: "My open PRs", q: "is:pr is:open archived:false author:@me", kind: "authored_pr" },
      { id: "assigned_issues", label: "Issues assigned to me", q: "is:issue is:open archived:false assignee:@me", kind: "assigned_issue" },
    ];
    for (const s of queries) {
      if (!scopes.includes(s.id)) continue;
      try {
        const r = await searchScope(ctx, s.q);
        const note = r.incomplete ? "GitHub reported incomplete search results" : r.error ? r.error.message : !r.complete ? `Stopped after ${MAX_PAGES} pages` : undefined;
        cov.add(s.label, r.complete ? (r.items.length ? "complete" : "empty") : "partial", r.items.length, r.pages, note);
        for (const item of r.items) {
          const repo = repoOf(item);
          const id = `${repo}#${item.number}`;
          let headSha: string | null = null;
          if (s.kind === "review_request") {
            try {
              const pr = await ctx.http.request<{ head: { sha: string } }>({ url: `${base(ctx)}/repos/${repo}/pulls/${item.number}`, headers: await headers(ctx) });
              headSha = pr.data.head.sha;
            } catch {
              headSha = null;
            }
          }
          const ageDays = Math.floor((ctx.now().getTime() - Date.parse(item.created_at)) / 86_400_000);
          observations.push({
            kind: s.kind,
            externalId: id,
            title: item.title,
            url: item.html_url,
            ...(item.user?.login ? { author: item.user.login } : {}),
            occurredAt: item.updated_at,
            data: { repo, number: item.number, state: item.state, draft: !!item.draft, headSha, body: (item.body ?? "").slice(0, 4000), labels: (item.labels ?? []).map((l) => l.name), createdAt: item.created_at },
            fingerprintParts: [item.title, item.state, !!item.draft, headSha ?? ""],
            ...(s.kind === "review_request" && !item.draft
              ? {
                  attention: {
                    key: `github:pr:${id}`,
                    kind: "review_request",
                    title: `Review ${repo}#${item.number}: ${item.title}`,
                    summary: `${item.user?.login ?? "Someone"} requested your review${ageDays > 0 ? ` ${ageDays} day${ageDays === 1 ? "" : "s"} ago` : " today"}.`,
                    why: "You are a requested reviewer on an open pull request.",
                    url: item.html_url,
                    priority: Math.min(90, 50 + ageDays * 5),
                    draftable: { actionKind: "github.comment", target: { repo, number: item.number, url: item.html_url }, context: { title: item.title, body: (item.body ?? "").slice(0, 4000), author: item.user?.login ?? null } },
                  },
                }
              : {}),
          });
        }
      } catch (e) {
        const err = e as RemoteError;
        cov.add(s.label, err.state ?? "error", 0, 0, err.message);
      }
    }
    return { coverage: cov.finish(), observations };
  },

  async execute(ctx, action) {
    if (action.kind !== "github.comment") throw new RemoteError(`Unsupported action ${action.kind}`, "error");
    const repo = String(action.target.repo ?? "");
    const number = Number(action.target.number);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(number)) throw new RemoteError("Invalid comment target", "error");
    const body = `${String(action.payload.body ?? "").trim()}\n\n${MARKER(action.effectKey)}`;
    const res = await ctx.http.request<{ id: number; html_url: string }>({ method: "POST", url: `${base(ctx)}/repos/${repo}/issues/${number}/comments`, headers: await headers(ctx), body: { body }, retries: 0 });
    const check = await afterWrite(async () => ctx.http.request<{ id: number; body: string }>({ url: `${base(ctx)}/repos/${repo}/issues/comments/${res.data.id}`, headers: await headers(ctx) }));
    const verified = !!check && check.data.id === res.data.id && check.data.body.includes(MARKER(action.effectKey));
    return { verified, remoteId: String(res.data.id), url: res.data.html_url, detail: { repo, number } };
  },

  async prepareContext(ctx, target) {
    const repo = String(target.repo ?? "");
    const number = Number(target.number);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(number)) return {};
    const r = await paginate<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>(
      async (cursor) => {
        const res = await ctx.http.request<Array<{ filename: string; status: string; additions: number; deletions: number; patch?: string }>>({ url: cursor ?? `${base(ctx)}/repos/${repo}/pulls/${number}/files?per_page=100`, headers: await headers(ctx) });
        return { items: res.data, next: nextLink(res.headers.get("link")) };
      },
      { maxPages: 3 },
    );
    return {
      changedFiles: r.items.map((f) => ({ file: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, patch: (f.patch ?? "").slice(0, 1500) })),
      filesComplete: r.complete,
    };
  },

  async findEffect(ctx, action) {
    const repo = String(action.target.repo ?? "");
    const number = Number(action.target.number);
    const r = await paginate<{ id: number; body: string; html_url: string }>(
      async (cursor) => {
        const res = await ctx.http.request<Array<{ id: number; body: string; html_url: string }>>({ url: cursor ?? `${base(ctx)}/repos/${repo}/issues/${number}/comments?per_page=100`, headers: await headers(ctx) });
        return { items: res.data, next: nextLink(res.headers.get("link")) };
      },
      { maxPages: 10 },
    );
    const found = r.items.find((c) => c.body.includes(MARKER(action.effectKey)));
    if (found) return { verified: true, remoteId: String(found.id), url: found.html_url, detail: { repo, number, recovered: true } };
    if (!r.complete) throw new RemoteError("Could not read all comments to check for an earlier attempt", "partial");
    return null;
  },
};
