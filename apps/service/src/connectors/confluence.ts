import type { ConnectorAdapter, AdapterContext, Observation, SyncResult, ExecuteResult } from "./types.ts";
import { CoverageTracker } from "./types.ts";
import { RemoteError, paginate } from "./http.ts";
import { asRemoteError, basicAuth, csvList, listingNote, listingState, normalizeSiteUrl, recordFailure, stringSetting } from "./common.ts";

interface SearchResult {
  content?: {
    id: string;
    type?: string;
    title?: string;
    version?: { number?: number; by?: { displayName?: string } };
    space?: { key?: string; name?: string };
    _links?: { webui?: string };
  };
  title?: string;
  excerpt?: string;
  url?: string;
  lastModified?: string;
}

interface Links {
  next?: string;
  base?: string;
  context?: string;
}

interface FooterComment {
  id: string;
  body?: { storage?: { value?: string } };
  _links?: { webui?: string };
}

const MAX_PAGES = 4;
const CONTEXT = "/wiki";
const PROPERTY_KEY = "jarvis-effect";
const SPACE_KEY = /^[A-Za-z0-9_~-]+$/;
const MARKER = (key: string) => `<!-- jarvis:effect=${key} -->`;

interface Scope {
  id: string;
  label: string;
  cql: (spaces: string[]) => string;
  mentions: boolean;
}

const SCOPES: Scope[] = [
  { id: "mentions", label: "Pages mentioning me (14 days)", cql: () => 'mention = currentUser() AND lastmodified >= now("-14d") ORDER BY lastmodified DESC', mentions: true },
  { id: "my_recent", label: "Pages I contributed to (14 days)", cql: () => 'contributor = currentUser() AND lastmodified >= now("-14d") ORDER BY lastmodified DESC', mentions: false },
  {
    id: "space_updates",
    label: "Updates in watched spaces (7 days)",
    cql: (spaces) => `space in (${spaces.map((s) => `"${s}"`).join(",")}) AND lastmodified >= now("-7d") ORDER BY lastmodified DESC`,
    mentions: false,
  },
];

/** Site root without the /wiki context, e.g. https://acme.atlassian.net. */
function siteSetting(ctx: AdapterContext): string {
  const raw = stringSetting(ctx.connection.settings, "siteUrl");
  if (!raw) throw new RemoteError("Confluence site URL is not configured", "not_configured");
  return raw.replace(/\/$/, "");
}

function base(ctx: AdapterContext): string {
  return ctx.endpoint(siteSetting(ctx)).replace(/\/$/, "");
}

/**
 * Resolve a `_links.next` value against the site. Confluence returns it
 * relative to `_links.base`, which already includes the /wiki context, so
 * "/rest/api/search?cursor=…" must become "<site>/wiki/rest/…" while v2's
 * "/wiki/api/v2/…" must not gain a second /wiki. Joining a bare
 * "/rest/…" onto the site origin is the classic 404.
 */
export function resolveNext(site: string, links: Links | undefined): string | null {
  const next = links?.next;
  if (!next) return null;
  if (/^https?:\/\//i.test(next)) {
    if (next.startsWith(`${site}/`)) return next;
    const u = new URL(next);
    return resolveNext(site, { ...links, next: `${u.pathname}${u.search}` });
  }
  const context = (links?.context ?? CONTEXT).replace(/\/$/, "");
  const path = next.startsWith("/") ? next : `/${next}`;
  if (context && (path === context || path.startsWith(`${context}/`))) return `${site}${path}`;
  return `${site}${context}${path}`;
}

async function headers(ctx: AdapterContext): Promise<Record<string, string>> {
  const token = await ctx.secret("apiToken");
  const email = stringSetting(ctx.connection.settings, "email");
  if (!token || !email) throw new RemoteError("No Confluence API token stored", "unauthorized");
  return { authorization: basicAuth(email, token) };
}

async function searchCql(ctx: AdapterContext, cql: string) {
  const h = await headers(ctx);
  const site = base(ctx);
  const first = `${site}${CONTEXT}/rest/api/search?${new URLSearchParams({ cql, limit: "50", expand: "content.version,content.space" })}`;
  return paginate<SearchResult>(
    async (cursor) => {
      const res = await ctx.http.request<{ results?: SearchResult[]; _links?: Links }>({ url: cursor ?? first, headers: h });
      return { items: res.data.results ?? [], next: resolveNext(site, res.data._links) };
    },
    { maxPages: MAX_PAGES },
  );
}

function pageUrl(ctx: AdapterContext, webui: string | undefined): string | undefined {
  if (!webui) return undefined;
  return `${siteSetting(ctx)}${CONTEXT}${webui.startsWith("/") ? webui : `/${webui}`}`;
}

function toObservation(ctx: AdapterContext, r: SearchResult, mention: boolean): Observation | null {
  const c = r.content;
  if (!c?.id) return null;
  const title = c.title ?? r.title ?? "(untitled)";
  const url = pageUrl(ctx, c._links?.webui);
  const version = c.version?.number ?? null;
  const by = c.version?.by?.displayName;
  return {
    kind: mention ? "confluence_mention" : "confluence_page",
    externalId: c.id,
    title,
    ...(url ? { url } : {}),
    ...(by ? { author: by } : {}),
    ...(r.lastModified ? { occurredAt: r.lastModified } : {}),
    data: { contentId: c.id, type: c.type ?? null, space: c.space?.key ?? null, version, excerpt: (r.excerpt ?? "").slice(0, 1000) },
    fingerprintParts: [title, version],
    ...(mention
      ? {
          attention: {
            key: `confluence:mention:${c.id}`,
            kind: "mention",
            title: `Mentioned in "${title}"`,
            summary: `${by ?? "Someone"} mentioned you${c.space?.name ? ` in ${c.space.name}` : ""}.`,
            why: "You are @mentioned on a recently updated Confluence page.",
            ...(url ? { url } : {}),
            priority: 55,
            draftable: { actionKind: "confluence.comment", target: { pageId: c.id, url: url ?? null }, context: { title, excerpt: (r.excerpt ?? "").slice(0, 2000) } },
          },
        }
      : {}),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Plain text to Confluence storage format: blank lines split paragraphs, newlines become <br/>. */
export function toStorage(text: string, effectKey: string): string {
  const paras = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return `${paras.map((p) => `<p>${p.split("\n").map(escapeHtml).join("<br/>")}</p>`).join("")}${MARKER(effectKey)}`;
}

function pageIdOf(target: Record<string, unknown>): string {
  const id = String(target.pageId ?? "");
  if (!/^\d+$/.test(id)) throw new RemoteError("Invalid Confluence page id", "error");
  return id;
}

async function readProperties(ctx: AdapterContext, commentId: string, h: Record<string, string>) {
  const site = base(ctx);
  return paginate<{ key: string; value: unknown }>(
    async (cursor) => {
      const res = await ctx.http.request<{ results?: Array<{ key: string; value: unknown }>; _links?: Links }>({ url: cursor ?? `${site}${CONTEXT}/api/v2/footer-comments/${commentId}/properties`, headers: h });
      return { items: res.data.results ?? [], next: resolveNext(site, res.data._links) };
    },
    { maxPages: 5 },
  );
}

async function commentHasEffect(ctx: AdapterContext, c: FooterComment, effectKey: string, h: Record<string, string>): Promise<boolean> {
  if ((c.body?.storage?.value ?? "").includes(MARKER(effectKey))) return true;
  const props = await readProperties(ctx, c.id, h);
  if (props.items.some((p) => p.key === PROPERTY_KEY && p.value === effectKey)) return true;
  if (!props.complete) throw new RemoteError("Could not read all comment properties", "partial");
  return false;
}

async function tagComment(ctx: AdapterContext, id: string, effectKey: string, h: Record<string, string>): Promise<string | null> {
  try {
    await ctx.http.request({ method: "POST", url: `${base(ctx)}${CONTEXT}/api/v2/footer-comments/${id}/properties`, headers: h, body: { key: PROPERTY_KEY, value: effectKey }, retries: 0 });
    return null;
  } catch (e) {
    return asRemoteError(e).message;
  }
}

export const confluenceAdapter: ConnectorAdapter = {
  kind: "confluence",
  secretNames: ["apiToken"],
  definition: {
    kind: "confluence",
    label: "Confluence",
    description: "Pages that mention you, pages you recently worked on, and optionally updates in chosen spaces.",
    authMethods: [
      {
        id: "api-token",
        label: "Atlassian API token",
        fields: [
          { id: "siteUrl", label: "Site URL", secret: false, placeholder: "https://acme.atlassian.net" },
          { id: "email", label: "Atlassian account email", secret: false, placeholder: "you@company.com" },
          { id: "apiToken", label: "API token", secret: true, help: "Create one at id.atlassian.com/manage-profile/security/api-tokens. It acts with your own Confluence permissions." },
          { id: "spaces", label: "Spaces to watch", secret: false, optional: true, placeholder: "ENG, OPS", help: "Comma-separated space keys. Leave empty to skip space updates." },
        ],
      },
    ],
    scopes: [
      { id: "mentions", label: "Pages mentioning me", default: true },
      { id: "my_recent", label: "Pages I recently contributed to", default: true },
      { id: "space_updates", label: "Updates in watched spaces", default: false },
    ],
    writeActions: [{ id: "confluence.comment", label: "Add a footer comment to a page" }],
    setupHelp: "Jarvis reads Confluence with your API token and your own permissions. Comments are only posted after you approve each draft.",
    unavoidableSteps: ["Create an Atlassian API token at id.atlassian.com/manage-profile/security/api-tokens."],
  },

  async configure(ctx, fields) {
    const siteUrl = normalizeSiteUrl(fields.siteUrl ?? "", /\/wiki$/);
    const email = fields.email?.trim() ?? "";
    const token = fields.apiToken?.trim() ?? "";
    if (!email.includes("@")) throw new RemoteError("Enter the email address of your Atlassian account", "unauthorized");
    if (!token) throw new RemoteError("An API token is required", "unauthorized");
    const spaces = csvList(fields.spaces ?? "");
    const bad = spaces.filter((s) => !SPACE_KEY.test(s));
    if (bad.length) throw new RemoteError(`Invalid space key: ${bad.join(", ")}`, "not_configured");
    await ctx.setSecret("apiToken", token);
    return { siteUrl, email, spaces: spaces.join(","), authMethod: "api-token" };
  },

  async test(ctx) {
    try {
      const res = await ctx.http.request<{ type?: string; accountType?: string; displayName?: string; email?: string; accountId?: string }>({ url: `${base(ctx)}${CONTEXT}/rest/api/user/current`, headers: await headers(ctx), retries: 1 });
      if (res.data.type === "anonymous" || res.data.accountType === "anonymous") return { ok: false, state: "unauthorized", account: null, message: "Confluence treated the request as anonymous; check the email and API token" };
      const account = res.data.email || res.data.displayName || res.data.accountId || null;
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
    const spaces = csvList(stringSetting(ctx.connection.settings, "spaces")).filter((s) => SPACE_KEY.test(s));
    for (const s of SCOPES) {
      if (!ctx.connection.readScopes.includes(s.id)) continue;
      if (s.id === "space_updates" && !spaces.length) {
        cov.add(s.label, "not_configured", 0, 0, "No spaces configured to watch");
        continue;
      }
      try {
        const r = await searchCql(ctx, s.cql(spaces));
        cov.add(s.label, listingState(r), r.items.length, r.pages, listingNote(r, MAX_PAGES));
        for (const item of r.items) {
          const obs = toObservation(ctx, item, s.mentions);
          if (!obs || seen.has(obs.externalId)) continue;
          seen.add(obs.externalId);
          observations.push(obs);
        }
      } catch (e) {
        recordFailure(cov, s.label, e);
      }
    }
    return { coverage: cov.finish(), observations };
  },

  async execute(ctx, action): Promise<ExecuteResult> {
    if (action.kind !== "confluence.comment") throw new RemoteError(`Unsupported action ${action.kind}`, "error");
    const pageId = pageIdOf(action.target);
    const text = String(action.payload.body ?? "").trim();
    if (!text) throw new RemoteError("The comment is empty", "error");
    const h = await headers(ctx);
    const body = { pageId, body: { representation: "storage", value: toStorage(text, action.effectKey) } };
    const res = await ctx.http.request<FooterComment>({ method: "POST", url: `${base(ctx)}${CONTEXT}/api/v2/footer-comments`, headers: h, body, retries: 0 });
    const id = String(res.data.id);
    const propertyError = await tagComment(ctx, id, action.effectKey, h);
    const check = await ctx.http.request<FooterComment>({ url: `${base(ctx)}${CONTEXT}/api/v2/footer-comments/${id}?body-format=storage`, headers: h });
    const verified = String(check.data.id) === id && (await commentHasEffect(ctx, check.data, action.effectKey, h));
    const url = pageUrl(ctx, check.data._links?.webui ?? res.data._links?.webui);
    return { verified, remoteId: id, ...(url ? { url } : {}), detail: { pageId, ...(propertyError ? { propertyError } : {}) } };
  },

  async findEffect(ctx, action) {
    const pageId = pageIdOf(action.target);
    const h = await headers(ctx);
    const site = base(ctx);
    const r = await paginate<FooterComment>(
      async (cursor) => {
        const res = await ctx.http.request<{ results?: FooterComment[]; _links?: Links }>({ url: cursor ?? `${site}${CONTEXT}/api/v2/pages/${pageId}/footer-comments?body-format=storage&limit=100`, headers: h });
        return { items: res.data.results ?? [], next: resolveNext(site, res.data._links) };
      },
      { maxPages: 10 },
    );
    for (const c of r.items) {
      if (await commentHasEffect(ctx, c, action.effectKey, h)) {
        const url = pageUrl(ctx, c._links?.webui);
        return { verified: true, remoteId: String(c.id), ...(url ? { url } : {}), detail: { pageId, recovered: true } };
      }
    }
    if (!r.complete) throw new RemoteError("Could not read all comments to check for an earlier attempt", "partial");
    return null;
  },
};
