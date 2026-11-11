/**
 * Shared access to the Atlassian Rovo MCP server for the Jira and Confluence
 * adapters. Jarvis is a direct MCP client (no model in the loop):
 *
 * - "oauth": OAuth 2.1 against the authorization server the MCP resource
 *   advertises (RFC 9728 → RFC 8414), dynamic client registration (RFC 7591)
 *   for a loopback redirect, PKCE S256 and a resource indicator (RFC 8707).
 * - "api-token": an Atlassian API token created for the MCP server, sent as
 *   Basic auth. The organization admin must allow API-token access.
 */
import type { ConnectionDefinition } from "@jarvis/contracts";
import type { AdapterContext } from "./types.ts";
import { RemoteError } from "./http.ts";
import { asRemoteError, basicAuth, normalizeSiteUrl, stringSetting } from "./common.ts";
import { McpHttpClient, toolErrorState } from "./mcp-http.ts";
import { configureClaude } from "./claude-adapter.ts";

export const ATLASSIAN_MCP_BASE = "https://mcp.atlassian.com";
export const ATLASSIAN_MCP_PATH = "/v2/mcp";
export const ATLASSIAN_SECRET_NAMES = ["apiToken", "accessToken", "accessTokenExpiresAt", "refreshToken", "clientSecret"];
export const API_TOKEN_URL = "https://id.atlassian.com/manage-profile/security/api-tokens?autofillToken&expiryDays=max&appId=mcp-v2&selectedScopes=all";

const EXPIRY_SLACK_MS = 60_000;
const clients = new WeakMap<AdapterContext, McpHttpClient>();

export type Product = "jira" | "confluence";

export function atlassianScopes(product: Product, includeWrite: boolean): string[] {
  const base = ["read:me", "read:account", "offline_access", `read:${product}:agent-interface`, `search:${product}:agent-interface`];
  return includeWrite ? [...base, `write:${product}:agent-interface`] : base;
}

/** The claude.ai connector for Atlassian, used through Claude Code like Slack, Gmail and Calendar. */
export const CLAUDE_ATLASSIAN_SERVER = "claude.ai Atlassian Rovo";

export function atlassianAuthMethods(product: Product, extraFields: ConnectionDefinition["authMethods"][number]["fields"] = []): ConnectionDefinition["authMethods"] {
  const site = { id: "siteUrl", label: "Site URL", secret: false, placeholder: "https://acme.atlassian.net" };
  const server = { id: "server", label: "Connector name in Claude Code", secret: false, optional: true, placeholder: CLAUDE_ATLASSIAN_SERVER, help: "Only change this if your organization named the claude.ai connector differently (see `claude mcp list`)." };
  return [
    {
      id: "claude-ai",
      label: "Your claude.ai Atlassian Rovo connector, through Claude Code on this computer (recommended)",
      reconnectHelp: "Make sure Claude Code is signed in on this computer (run `claude` once in a terminal) and that Atlassian Rovo shows as connected in claude.ai → Settings → Connectors, then reconnect.",
      fields: [site, ...extraFields, server],
    },
    { id: "oauth", label: "Sign in with Atlassian directly (if your organization allows other MCP clients)", browserSignIn: true, fields: [site, ...extraFields] },
    {
      id: "api-token",
      label: "Atlassian API token for the MCP server",
      fields: [
        site,
        { id: "email", label: "Atlassian account email", secret: false, placeholder: "you@company.com" },
        { id: "apiToken", label: "API token", secret: true, help: `Create a token for the Atlassian MCP server (app "mcp-v2") at ${API_TOKEN_URL}. A classic unscoped token is rejected. It acts with your own ${product === "jira" ? "Jira" : "Confluence"} permissions.` },
        ...extraFields,
      ],
    },
  ];
}

export function atlassianSetupSteps(): string[] {
  return [
    "Recommended: connect Atlassian Rovo in claude.ai → Settings → Connectors with your work account, and have Claude Code installed and signed in on this computer. Nothing else is needed; Jarvis stores no Atlassian credential.",
    "Signing in directly instead: your Atlassian organization must allow the Atlassian Rovo MCP server. If sign-in or the API token is refused, an org admin manages it in Atlassian Administration → your organization → Rovo → Rovo MCP server (trusted domains, and whether API tokens are allowed). Jarvis signs in from this computer (http://127.0.0.1).",
    "Signing in directly the first time asks you to approve Jarvis for your site; approve it for the site you enter here.",
  ];
}

function mcpUrl(ctx: AdapterContext): string {
  return `${ctx.endpoint(ATLASSIAN_MCP_BASE).replace(/\/$/, "")}${ATLASSIAN_MCP_PATH}`;
}

export function siteUrl(ctx: AdapterContext): string {
  const raw = stringSetting(ctx.connection.settings, "siteUrl");
  if (!raw) throw new RemoteError("The Atlassian site URL is not configured", "not_configured");
  return raw.replace(/\/$/, "");
}

/** What the MCP tools accept as cloudId: the resolved site UUID, else the site URL. */
export function cloudId(ctx: AdapterContext): string {
  return stringSetting(ctx.connection.settings, "cloudId") || siteUrl(ctx);
}

export async function configureAtlassian(ctx: AdapterContext, fields: Record<string, string>, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const method = fields.method === "api-token" ? "api-token" : fields.method === "oauth" ? "oauth" : "claude-ai";
  const site = normalizeSiteUrl(fields.siteUrl ?? "", /\/wiki$/);
  if (method === "claude-ai") {
    // Authorization lives in claude.ai; the site is resolved to its cloud id on the first test.
    const settings = configureClaude(fields, CLAUDE_ATLASSIAN_SERVER, { siteUrl: site, transport: "mcp", ...extra });
    return stringSetting(ctx.connection.settings, "siteUrl") === site && ctx.connection.settings.cloudId ? { ...settings, cloudId: ctx.connection.settings.cloudId } : settings;
  }
  if (method === "api-token") {
    const email = fields.email?.trim() ?? "";
    const token = fields.apiToken?.trim() ?? "";
    if (!email.includes("@")) throw new RemoteError("Enter the email address of your Atlassian account", "unauthorized");
    if (!token) throw new RemoteError("An API token is required", "unauthorized");
    await ctx.setSecret("apiToken", token);
    return { siteUrl: site, email, authMethod: "api-token", transport: "mcp", ...extra };
  }
  // Keep a registered OAuth client and granted scopes when the site is unchanged.
  const prev = ctx.connection.settings;
  const same = stringSetting(prev, "siteUrl") === site && prev.authMethod === "oauth";
  return { siteUrl: site, authMethod: "oauth", transport: "mcp", ...(same ? { oauthClient: prev.oauthClient, grantedScopes: prev.grantedScopes ?? "", cloudId: prev.cloudId } : {}), ...extra };
}

// ---- OAuth -------------------------------------------------------------------------------

interface AuthServer {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

interface OAuthClient {
  clientId: string;
  redirectUri: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  resource: string;
}

function requireSecureUrl(raw: string, what: string): string {
  const u = new URL(raw);
  const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback && process.env.JARVIS_TEST_ENDPOINTS === "1")) throw new RemoteError(`Refusing a non-https ${what}: ${u.origin}`, "error");
  return u.toString();
}

/** RFC 9728 protected-resource metadata, then RFC 8414 metadata of its first authorization server. */
async function discover(ctx: AdapterContext): Promise<{ resource: string; server: AuthServer }> {
  const resourceUrl = mcpUrl(ctx);
  const ru = new URL(resourceUrl);
  const same = (a: string, b: string) => a.replace(/\/$/, "") === b.replace(/\/$/, "");
  const prm = await ctx.http.request<{ resource?: string; authorization_servers?: string[] }>({ url: `${ru.origin}/.well-known/oauth-protected-resource${ru.pathname.replace(/\/$/, "")}`, retries: 1 });
  // RFC 9728: the metadata must describe this resource, not another one.
  if (prm.data.resource && !same(prm.data.resource, resourceUrl)) throw new RemoteError(`The MCP server's metadata names a different resource (${prm.data.resource})`, "error");
  const issuer = prm.data.authorization_servers?.[0];
  if (!issuer) throw new RemoteError("The Atlassian MCP server did not advertise an authorization server", "error");
  const iu = new URL(requireSecureUrl(issuer, "authorization server"));
  const candidates = [`${iu.origin}/.well-known/oauth-authorization-server${iu.pathname.replace(/\/$/, "")}`, `${iu.origin}${iu.pathname.replace(/\/$/, "")}/.well-known/oauth-authorization-server`];
  for (const url of candidates) {
    let meta: AuthServer | undefined;
    try {
      meta = (await ctx.http.request<AuthServer>({ url, retries: 1 })).data;
    } catch {
      continue;
    }
    if (!meta?.authorization_endpoint || !meta.token_endpoint) continue;
    // RFC 8414: the issuer in the metadata must be the server we were pointed at.
    if (meta.issuer && !same(meta.issuer, issuer)) throw new RemoteError(`The authorization server metadata has issuer ${meta.issuer}, expected ${issuer}`, "error");
    if (meta.code_challenge_methods_supported && !meta.code_challenge_methods_supported.includes("S256")) throw new RemoteError("The Atlassian authorization server does not support PKCE S256", "error");
    return { resource: prm.data.resource || resourceUrl, server: meta };
  }
  throw new RemoteError("Could not read the Atlassian authorization server metadata", "offline");
}

async function registeredClient(ctx: AdapterContext, redirectUri: string): Promise<OAuthClient> {
  const existing = ctx.connection.settings.oauthClient as OAuthClient | undefined;
  if (existing?.clientId && existing.redirectUri === redirectUri) return existing;
  const { resource, server } = await discover(ctx);
  if (!server.registration_endpoint) throw new RemoteError("The Atlassian authorization server does not offer client registration", "error");
  const reg = await ctx.http.request<{ client_id?: string; client_secret?: string }>({
    method: "POST",
    url: requireSecureUrl(server.registration_endpoint, "registration endpoint"),
    body: { client_name: "Jarvis (local)", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
    retries: 0,
  });
  if (!reg.data.client_id) throw new RemoteError("Atlassian did not register a client for Jarvis", "error");
  if (reg.data.client_secret) await ctx.setSecret("clientSecret", reg.data.client_secret);
  return {
    clientId: reg.data.client_id,
    redirectUri,
    authorizationEndpoint: requireSecureUrl(server.authorization_endpoint, "authorization endpoint"),
    tokenEndpoint: requireSecureUrl(server.token_endpoint, "token endpoint"),
    resource,
  };
}

/** Build the browser sign-in URL. The registered client is returned so the caller can persist it. */
export async function atlassianAuthorizeUrl(ctx: AdapterContext, p: { redirectUri: string; state: string; codeChallenge: string; scopes: string[] }): Promise<{ url: string; settings: Record<string, unknown> }> {
  const client = await registeredClient(ctx, p.redirectUri);
  const qs = new URLSearchParams({ response_type: "code", client_id: client.clientId, redirect_uri: p.redirectUri, scope: p.scopes.join(" "), state: p.state, code_challenge: p.codeChallenge, code_challenge_method: "S256", resource: client.resource, prompt: "consent" });
  return { url: `${client.authorizationEndpoint}?${qs}`, settings: { oauthClient: client } };
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

function oauthClient(ctx: AdapterContext): OAuthClient {
  const c = ctx.connection.settings.oauthClient as OAuthClient | undefined;
  if (!c?.clientId) throw new RemoteError("Sign in with Atlassian first", "unauthorized");
  return c;
}

async function tokenRequest(ctx: AdapterContext, form: Record<string, string>, retries: number): Promise<TokenResponse> {
  const c = oauthClient(ctx);
  try {
    const res = await ctx.http.request<TokenResponse>({ method: "POST", url: c.tokenEndpoint, form: { ...form, client_id: c.clientId, resource: c.resource }, retries });
    return res.data;
  } catch (e) {
    const err = asRemoteError(e);
    if (/invalid_grant/.test(err.message)) throw new RemoteError("Atlassian rejected the stored sign-in (invalid_grant). Sign in with Atlassian again.", "unauthorized", err.status);
    if (/invalid_client|unauthorized_client/.test(err.message)) throw new RemoteError("Atlassian no longer recognises Jarvis's registered client. Sign in with Atlassian again.", "unauthorized", err.status);
    throw err;
  }
}

async function storeTokens(ctx: AdapterContext, t: TokenResponse): Promise<string> {
  if (!t.access_token) throw new RemoteError("Atlassian did not return an access token", "error");
  await ctx.setSecret("accessToken", t.access_token);
  await ctx.setSecret("accessTokenExpiresAt", new Date(ctx.now().getTime() + (t.expires_in ?? 3600) * 1000).toISOString());
  if (t.refresh_token) await ctx.setSecret("refreshToken", t.refresh_token);
  return t.access_token;
}

export async function atlassianExchangeCode(ctx: AdapterContext, p: { code: string; redirectUri: string; codeVerifier: string }): Promise<{ grantedScopes: string }> {
  const t = await tokenRequest(ctx, { grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, code_verifier: p.codeVerifier }, 0);
  if (!t.refresh_token) throw new RemoteError("Atlassian did not return a refresh token (offline_access). Sign in again and approve all requested permissions.", "unauthorized");
  await storeTokens(ctx, t);
  return { grantedScopes: t.scope ?? "" };
}

/** One refresh at a time per connection: Atlassian rotates refresh tokens, so a second concurrent refresh would present a spent token. */
const refreshing = new Map<string, Promise<string>>();

function refreshAccessToken(ctx: AdapterContext): Promise<string> {
  const key = ctx.connection.id;
  const inflight = refreshing.get(key);
  if (inflight) return inflight;
  const run = (async () => {
    const refreshToken = await ctx.secret("refreshToken");
    if (!refreshToken) throw new RemoteError("Sign in with Atlassian first", "unauthorized");
    return storeTokens(ctx, await tokenRequest(ctx, { grant_type: "refresh_token", refresh_token: refreshToken }, 1));
  })().finally(() => refreshing.delete(key));
  refreshing.set(key, run);
  return run;
}

async function bearer(ctx: AdapterContext): Promise<string> {
  const token = await ctx.secret("accessToken");
  const expiresAt = Date.parse((await ctx.secret("accessTokenExpiresAt")) ?? "");
  if (token && Number.isFinite(expiresAt) && expiresAt - EXPIRY_SLACK_MS > ctx.now().getTime()) return token;
  return refreshAccessToken(ctx);
}

export async function isAtlassianAuthorized(ctx: AdapterContext): Promise<boolean> {
  if (ctx.connection.settings.authMethod === "claude-ai") return true;
  if (ctx.connection.settings.authMethod === "api-token") return !!(await ctx.secret("apiToken"));
  return !!(await ctx.secret("refreshToken"));
}

export function grantedScopes(ctx: AdapterContext): string[] {
  return stringSetting(ctx.connection.settings, "grantedScopes").split(/\s+/).filter(Boolean);
}

// ---- tool calls ----------------------------------------------------------------------------

function client(ctx: AdapterContext): McpHttpClient {
  let c = clients.get(ctx);
  if (!c) {
    const apiToken = ctx.connection.settings.authMethod === "api-token";
    c = new McpHttpClient(
      mcpUrl(ctx),
      {
        header: async () => {
          if (!apiToken) return `Bearer ${await bearer(ctx)}`;
          const token = await ctx.secret("apiToken");
          const email = stringSetting(ctx.connection.settings, "email");
          if (!token || !email) throw new RemoteError("No Atlassian API token stored", "unauthorized");
          return basicAuth(email, token);
        },
        ...(apiToken
          ? {}
          : {
              // A rejected refresh means "sign in again"; a network failure stays a network failure.
              refresh: async () => {
                try {
                  await refreshAccessToken(ctx);
                  return true;
                } catch (e) {
                  if (asRemoteError(e).state === "unauthorized") return false;
                  throw e;
                }
              },
            }),
      },
      ctx.signal,
      { clientName: "jarvis", baseDelayMs: process.env.JARVIS_TEST_ENDPOINTS === "1" ? 5 : 500 },
    );
    clients.set(ctx, c);
  }
  return c;
}

/** Parse a tool result: JSON when it is JSON, else the raw text. Tool-level errors become classified RemoteErrors. */
export function parseToolResult(tool: string, r: { text: string; isError: boolean }): unknown {
  let data: unknown = r.text;
  try {
    data = JSON.parse(r.text);
  } catch {
    // Plain text result.
  }
  const obj = data && typeof data === "object" ? (data as { error?: unknown; message?: unknown; statusCode?: unknown }) : null;
  if (r.isError || (obj && obj.error === true)) {
    const status = typeof obj?.statusCode === "number" ? obj.statusCode : null;
    const message = typeof obj?.message === "string" ? obj.message : r.text.slice(0, 300) || "unknown error";
    const state = toolErrorState(status, message);
    const hint = state === "unauthorized" && /scope/i.test(message) ? " The credential lacks the Atlassian MCP scopes: sign in with Atlassian again, or create the API token for the MCP server (app mcp-v2)." : "";
    throw new RemoteError(`Atlassian ${tool} failed: ${message}${hint}`, state, status);
  }
  return data;
}

export async function atlassianCall<T = unknown>(ctx: AdapterContext, tool: string, args: Record<string, unknown>, opts: { write?: boolean } = {}): Promise<T> {
  const r = await client(ctx).callTool(tool, args, { retries: opts.write ? 0 : 2 });
  return parseToolResult(tool, r) as T;
}

/** Run a non-primary operation through the execute meta-tools. */
export async function atlassianExecute<T = unknown>(ctx: AdapterContext, name: string, inputs: Record<string, unknown>, opts: { write?: boolean } = {}): Promise<T> {
  return atlassianCall<T>(ctx, opts.write ? "executeWrite" : "executeRead", { cloudId: cloudId(ctx), name, inputs }, opts);
}

interface Resource {
  id?: string;
  url?: string;
  name?: string;
  scopes?: string[];
}

/** The account behind an atlassianUserInfo result. */
export function accountOf(me: unknown): string | null {
  const m = (me ?? {}) as Record<string, unknown>;
  return [m.email, m.name, m.account_id, m.accountId].find((v): v is string => typeof v === "string" && !!v) ?? null;
}

/**
 * Resolve the configured site among the accessible resources, so a credential
 * for the wrong site is reported instead of silently reading nothing.
 */
export function resolveSite(resources: unknown, site: string): { cloudId: string; siteName: string | null } {
  const list = (Array.isArray(resources) ? resources : ((resources as { resources?: unknown })?.resources ?? [])) as Resource[];
  const match = list.find((r) => typeof r.url === "string" && r.url.replace(/\/$/, "").toLowerCase() === site.toLowerCase());
  if (!match?.id) {
    const names = [...new Set(list.map((r) => r.url).filter(Boolean))].join(", ") || "none";
    throw new RemoteError(`Your Atlassian account has no access to ${site} through the MCP server. Sites available: ${names}.`, "denied");
  }
  return { cloudId: match.id, siteName: match.name ?? null };
}

export async function identifyAtlassian(ctx: AdapterContext): Promise<{ account: string | null; cloudId: string; siteName: string | null }> {
  const me = await atlassianCall<Record<string, unknown>>(ctx, "atlassianUserInfo", {});
  const raw = await atlassianCall<unknown>(ctx, "getAccessibleAtlassianResources", {});
  return { account: accountOf(me), ...resolveSite(raw, siteUrl(ctx)) };
}
