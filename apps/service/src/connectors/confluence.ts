/**
 * Confluence through the Atlassian Rovo MCP server, reached either through the
 * user's claude.ai connector or Jarvis's own MCP client (atlassian-backend.ts).
 * Reads are CQL searches; the one write is a footer comment, read back from
 * the page's footer comments.
 */
import type { ConnectorAdapter, AdapterContext, Observation, RefreshResult, ExecuteResult } from "./types.ts";
import { CoverageTracker } from "./types.ts";
import { RemoteError, afterWrite } from "./http.ts";
import { asRemoteError, attemptStartMs, csvList, listingNote, listingState, recordFailure, sameLooseText, stringSetting } from "./common.ts";
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
import { adfText, authorId, normalizeText, pick, str } from "./atlassian-shapes.ts";
import { atlassianBackend, usesClaude } from "./atlassian-backend.ts";
import { plural } from "@jarvis/contracts";

export interface ConfluenceHit {
  id: string;
  type: string | null;
  title: string;
  space: string | null;
  spaceName: string | null;
  version: number | null;
  by: string | null;
  webui: string | null;
  excerpt: string;
  lastModified: string | null;
}

const MAX_PAGES = 4;
const CONTEXT = "/wiki";
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

/** Accepts the REST search shape ({content: {...}, excerpt}) and a flattened hit. */
export function normalizeHit(raw: unknown): ConfluenceHit | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const c = (r.content && typeof r.content === "object" ? r.content : r) as Record<string, unknown>;
  const id = str(c.id);
  if (!id || !/^\d+$/.test(id)) return null;
  const version = pick(c, "version", "number") ?? c.version;
  return {
    id,
    type: str(c.type),
    title: str(c.title) ?? str(r.title) ?? "(untitled)",
    space: str(pick(c, "space", "key")) ?? str(c.spaceKey),
    spaceName: str(pick(c, "space", "name")),
    version: typeof version === "number" ? version : null,
    by: str(pick(c, "version", "by", "displayName")) ?? str(pick(c, "version", "authorName")) ?? str(pick(c, "author", "displayName")),
    webui: str(pick(c, "_links", "webui")) ?? str(pick(r, "_links", "webui")) ?? str(r.url) ?? str(c.webUrl),
    excerpt: str(r.excerpt) ?? str(c.summary) ?? "",
    // Only real timestamps: some views say "about 2 hours ago", which is neither a date nor stable.
    lastModified: [r.lastModified, c.lastModified, pick(c, "version", "when"), pick(c, "version", "createdAt")].map(str).find((v) => !!v && /^\d{4}-\d{2}-\d{2}T/.test(v)) ?? null,
  };
}

function pageUrl(ctx: AdapterContext, webui: string | null): string | undefined {
  if (!webui) return undefined;
  if (/^https?:\/\//.test(webui)) return webui;
  const path = webui.startsWith(CONTEXT) ? webui : `${CONTEXT}${webui.startsWith("/") ? webui : `/${webui}`}`;
  return `${siteUrl(ctx)}${path}`;
}

function toObservation(ctx: AdapterContext, h: ConfluenceHit, mention: boolean): Observation {
  const url = pageUrl(ctx, h.webui);
  return {
    kind: mention ? "confluence_mention" : "confluence_page",
    externalId: h.id,
    title: h.title,
    ...(url ? { url } : {}),
    ...(h.by ? { author: h.by } : {}),
    ...(h.lastModified ? { occurredAt: h.lastModified } : {}),
    data: { contentId: h.id, type: h.type, space: h.space, version: h.version, excerpt: h.excerpt.slice(0, 1000) },
    // Version where the view has it; otherwise the excerpt, which changes when the page does (a relative date would not be stable).
    fingerprintParts: [h.title, h.version ?? h.excerpt],
    ...(mention
      ? {
          attention: {
            key: `confluence:mention:${h.id}`,
            kind: "mention",
            title: `Mentioned in "${h.title}"`,
            summary: `${h.by ?? "Someone"} mentioned you${h.spaceName ? ` in ${h.spaceName}` : ""}.`,
            why: "You are @mentioned on a recently updated Confluence page.",
            ...(url ? { url } : {}),
            priority: 55,
            draftable: { actionKind: "confluence.comment", target: { pageId: h.id, url: url ?? null }, context: { title: h.title, excerpt: h.excerpt.slice(0, 2000) } },
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

function commentBody(c: Record<string, unknown>): string {
  const b = c.body;
  if (typeof b === "string") return b;
  // Whichever representation the view returned: storage HTML, Markdown, a bare value, or ADF.
  return str(pick(b, "storage", "value")) ?? str(pick(b, "markdown", "value")) ?? str(pick(b, "view", "value")) ?? str(pick(b, "value")) ?? adfText(pick(b, "atlas_doc_format", "value") ?? b);
}

function storageText(html: string): string {
  return normalizeText(html.replace(/<!--[\s\S]*?-->/g, "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
}

/** Ours when the storage body kept the effect marker, else my own comment, created after the attempt started, with the same text. */
function isOurComment(c: Record<string, unknown>, text: string, effectKey: string, selfId: string, fromMs: number): boolean {
  const body = commentBody(c);
  if (body.includes(MARKER(effectKey))) return true;
  const created = Date.parse(str(pick(c, "version", "createdAt")) ?? str(c.created) ?? "");
  if (Number.isFinite(created) && created < fromMs) return false;
  return authorId(c) === selfId && sameLooseText(storageText(body), text);
}

const SPACES_FIELD = { id: "spaces", label: "Spaces to watch", secret: false, optional: true, placeholder: "ENG, OPS", help: "Comma-separated space keys. Leave empty to skip space updates." };

export const confluenceAdapter: ConnectorAdapter = {
  kind: "confluence",
  secretNames: ATLASSIAN_SECRET_NAMES,
  definition: {
    kind: "confluence",
    label: "Confluence",
    description: "Pages that mention you, pages you recently worked on, and optionally updates in chosen spaces.",
    authMethods: atlassianAuthMethods("confluence", [SPACES_FIELD]),
    scopes: [
      { id: "mentions", label: "Pages mentioning me", default: true },
      { id: "my_recent", label: "Pages I recently contributed to", default: true },
      { id: "space_updates", label: "Updates in watched spaces", default: false },
    ],
    writeActions: [{ id: "confluence.comment", label: "Add a footer comment to a page" }],
    setupHelp: "Jarvis connects to Confluence through the Atlassian Rovo MCP server with your own permissions, read-only unless you authorise commenting. Comments are only posted after you approve each draft.",
    unavoidableSteps: atlassianSetupSteps(),
  },

  async configure(ctx, fields) {
    const spaces = csvList(fields.spaces ?? "");
    const bad = spaces.filter((s) => !SPACE_KEY.test(s));
    if (bad.length) throw new RemoteError(`Invalid space key: ${bad.join(", ")}`, "not_configured");
    return configureAtlassian(ctx, fields, { spaces: spaces.join(",") });
  },
  oauthScopes: (includeWrite) => atlassianScopes("confluence", includeWrite),
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
      const who = usesClaude(ctx) ? await ctx.claude.account(ctx.signal) : null;
      const me = await atlassianBackend(ctx).identify();
      const resolved = { ...ctx, connection: { ...ctx.connection, settings: { ...ctx.connection.settings, cloudId: me.cloudId } } };
      const probe = (await atlassianBackend(resolved).searchCql([{ id: "probe", query: "contributor = currentUser() ORDER BY lastmodified DESC" }], { maxPages: 1, pageSize: 1 })).get("probe")!;
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
    const spaces = csvList(stringSetting(ctx.connection.settings, "spaces")).filter((s) => SPACE_KEY.test(s));
    const selected = SCOPES.filter((s) => ctx.connection.readScopes.includes(s.id));
    for (const s of selected.filter((x) => x.id === "space_updates" && !spaces.length)) cov.add(s.label, "not_configured", 0, 0, "No spaces configured to watch");
    const runnable = selected.filter((s) => !(s.id === "space_updates" && !spaces.length));
    if (!runnable.length) return { coverage: cov.finish(), observations };
    const results = await atlassianBackend(ctx).searchCql(runnable.map((s) => ({ id: s.id, query: s.cql(spaces) })), { maxPages: MAX_PAGES });
    for (const s of runnable) {
      const r = results.get(s.id)!;
      if (r.error && r.pages === 0) {
        recordFailure(cov, s.label, r.error);
        continue;
      }
      const hits = r.items.map(normalizeHit);
      const unreadable = hits.filter((h) => !h).length;
      const valid = hits.filter((h): h is ConfluenceHit => !!h);
      const extra = [...r.notes, ...(unreadable ? [`${plural(unreadable, "result")} had no readable page id`] : [])];
      cov.add(s.label, unreadable || r.notes.length ? "partial" : listingState({ items: valid, complete: r.complete }), valid.length, r.pages, listingNote({ complete: r.complete, error: r.error }, MAX_PAGES, extra));
      for (const hit of valid) {
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        observations.push(toObservation(ctx, hit, s.mentions));
      }
    }
    return { coverage: cov.finish(), observations };
  },

  async execute(ctx, action): Promise<ExecuteResult> {
    if (action.kind !== "confluence.comment") throw new RemoteError(`Unsupported action ${action.kind}`, "error");
    const pageId = pageIdOf(action.target);
    const text = String(action.payload.body ?? "").trim();
    if (!text) throw new RemoteError("The comment is empty", "error");
    const b = atlassianBackend(ctx);
    const res = await b.addConfluenceComment(pageId, text, toStorage(text, action.effectKey));
    const id = str(res?.id) ?? str(res?.commentId) ?? str(pick(res, "comment", "id"));
    if (!id) throw new RemoteError("Confluence accepted the comment but returned no comment id; it will be looked up before any retry", "error");
    const check = await afterWrite(() => b.listConfluenceComments(pageId));
    const found = check?.items.find((c) => String(c.id) === id);
    const url = pageUrl(ctx, str(pick(found, "_links", "webui")) ?? str(pick(res, "_links", "webui")));
    return { verified: !!found, remoteId: id, ...(url ? { url } : {}), detail: { pageId } };
  },

  async findEffect(ctx, action) {
    const pageId = pageIdOf(action.target);
    const text = String(action.payload.body ?? "");
    const b = atlassianBackend(ctx);
    const selfId = await b.selfAccountId();
    const r = await b.listConfluenceComments(pageId);
    const found = r.items.find((c) => isOurComment(c, text, action.effectKey, selfId, attemptStartMs(action.since, 0)));
    if (found) {
      const url = pageUrl(ctx, str(pick(found, "_links", "webui")));
      return { verified: true, remoteId: String(found.id), ...(url ? { url } : {}), detail: { pageId, recovered: true } };
    }
    if (!r.complete) throw new RemoteError("Could not read all comments to check for an earlier attempt", "partial");
    return null;
  },
};
