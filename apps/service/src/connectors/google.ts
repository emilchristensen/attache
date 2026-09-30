/**
 * Shared Google OAuth (installed-app flow with PKCE) for the Gmail and
 * Calendar adapters. The user brings their own "Desktop app" OAuth client;
 * tokens are stored as connection secrets and refreshed on demand.
 */
import type { ConnectionDefinition } from "@jarvis/contracts";
import type { AdapterContext } from "./types.ts";
import type { HttpRequest, HttpResponse } from "./http.ts";
import { RemoteError } from "./http.ts";
import { asRemoteError, stringSetting } from "./common.ts";

export const GOOGLE_OAUTH_BASE = "https://oauth2.googleapis.com";
export const GOOGLE_ACCOUNTS_BASE = "https://accounts.google.com";
export const GOOGLE_SECRET_NAMES = ["clientSecret", "refreshToken", "accessToken", "accessTokenExpiresAt"];

const EXPIRY_SLACK_MS = 60_000;
const RECONNECT = "Reconnect this Google account in Jarvis. If your OAuth consent screen is in Testing mode, Google expires its refresh tokens after 7 days.";

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export function googleAuthMethod(): ConnectionDefinition["authMethods"][number] {
  return {
    id: "oauth",
    label: "Sign in with Google (your own OAuth client)",
    fields: [
      { id: "clientId", label: "OAuth client ID", secret: false, placeholder: "1234-abc.apps.googleusercontent.com", help: "From Google Cloud Console → APIs & Services → Credentials → your Desktop app client." },
      { id: "clientSecret", label: "OAuth client secret", secret: true, placeholder: "GOCSPX-…" },
    ],
  };
}

export function googleSetupSteps(api: string): string[] {
  return [
    "Create (or pick) a project at console.cloud.google.com.",
    `Enable the ${api} for that project (APIs & Services → Library).`,
    "Configure the OAuth consent screen (External or Internal), and add your own Google account as a test user.",
    "Create credentials → OAuth client ID → application type \"Desktop app\", then paste its client ID and secret here.",
    "While the consent screen is in Testing mode, Google expires refresh tokens after 7 days, so you will need to reconnect weekly unless you publish the app.",
  ];
}

export async function configureGoogle(ctx: AdapterContext, fields: Record<string, string>): Promise<Record<string, unknown>> {
  const clientId = fields.clientId?.trim() ?? "";
  const clientSecret = fields.clientSecret?.trim() ?? "";
  if (!/\.apps\.googleusercontent\.com$/.test(clientId)) throw new RemoteError("Enter the client ID of a Google OAuth Desktop client (ends in .apps.googleusercontent.com)", "not_configured");
  if (!clientSecret) throw new RemoteError("The OAuth client secret is required", "not_configured");
  await ctx.setSecret("clientSecret", clientSecret);
  return { clientId, authMethod: "oauth", grantedScopes: stringSetting(ctx.connection.settings, "grantedScopes") };
}

function clientId(ctx: AdapterContext): string {
  const id = stringSetting(ctx.connection.settings, "clientId");
  if (!id) throw new RemoteError("Google OAuth client is not configured", "not_configured");
  return id;
}

async function clientSecret(ctx: AdapterContext): Promise<string> {
  const s = await ctx.secret("clientSecret");
  if (!s) throw new RemoteError("Google OAuth client secret is not stored", "unauthorized");
  return s;
}

export function buildAuthorizeUrl(ctx: AdapterContext, p: { redirectUri: string; state: string; codeChallenge: string; scopes: string[] }): string {
  if (!p.scopes.length) throw new RemoteError("No Google scopes requested", "error");
  const qs = new URLSearchParams({
    client_id: clientId(ctx),
    redirect_uri: p.redirectUri,
    response_type: "code",
    scope: p.scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    code_challenge: p.codeChallenge,
    code_challenge_method: "S256",
    state: p.state,
  });
  return `${ctx.endpoint(GOOGLE_ACCOUNTS_BASE).replace(/\/$/, "")}/o/oauth2/v2/auth?${qs}`;
}

/** Translate token-endpoint failures: invalid_grant means the grant is gone and only reconnecting helps. */
function tokenError(e: unknown): RemoteError {
  const err = asRemoteError(e);
  if (/invalid_grant/.test(err.message)) return new RemoteError(`Google rejected the stored authorization (invalid_grant). ${RECONNECT}`, "unauthorized", err.status);
  if (/invalid_client|unauthorized_client/.test(err.message)) return new RemoteError("Google rejected the OAuth client ID or secret. Check the Desktop client credentials and reconnect.", "unauthorized", err.status);
  return err;
}

async function storeTokens(ctx: AdapterContext, t: TokenResponse): Promise<string> {
  if (!t.access_token) throw new RemoteError("Google did not return an access token", "error");
  const expiresAt = new Date(ctx.now().getTime() + (t.expires_in ?? 3600) * 1000).toISOString();
  await ctx.setSecret("accessToken", t.access_token);
  await ctx.setSecret("accessTokenExpiresAt", expiresAt);
  if (t.refresh_token) await ctx.setSecret("refreshToken", t.refresh_token);
  return t.access_token;
}

async function tokenRequest(ctx: AdapterContext, form: Record<string, string>, retries: number): Promise<TokenResponse> {
  try {
    const res = await ctx.http.request<TokenResponse>({ method: "POST", url: `${ctx.endpoint(GOOGLE_OAUTH_BASE).replace(/\/$/, "")}/token`, form, retries });
    return res.data;
  } catch (e) {
    throw tokenError(e);
  }
}

export async function exchangeCode(ctx: AdapterContext, p: { code: string; redirectUri: string; codeVerifier: string }): Promise<{ grantedScopes: string }> {
  const t = await tokenRequest(ctx, { grant_type: "authorization_code", code: p.code, redirect_uri: p.redirectUri, code_verifier: p.codeVerifier, client_id: clientId(ctx), client_secret: await clientSecret(ctx) }, 0);
  if (!t.refresh_token) throw new RemoteError("Google did not return a refresh token. Remove Jarvis from myaccount.google.com/permissions and connect again.", "unauthorized");
  await storeTokens(ctx, t);
  return { grantedScopes: t.scope ?? "" };
}

async function refreshAccessToken(ctx: AdapterContext): Promise<string> {
  const refreshToken = await ctx.secret("refreshToken");
  if (!refreshToken) throw new RemoteError("Google account is not connected", "unauthorized");
  const t = await tokenRequest(ctx, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId(ctx), client_secret: await clientSecret(ctx) }, 1);
  return storeTokens(ctx, t);
}

async function accessToken(ctx: AdapterContext): Promise<string> {
  const token = await ctx.secret("accessToken");
  const expiresAt = Date.parse((await ctx.secret("accessTokenExpiresAt")) ?? "");
  if (token && Number.isFinite(expiresAt) && expiresAt - EXPIRY_SLACK_MS > ctx.now().getTime()) return token;
  return refreshAccessToken(ctx);
}

/** An authenticated Google API request; a 401 triggers one forced refresh (safe: nothing was applied). */
export async function googleRequest<T>(ctx: AdapterContext, req: HttpRequest): Promise<HttpResponse<T>> {
  const withToken = (t: string) => ({ ...req, headers: { ...(req.headers ?? {}), authorization: `Bearer ${t}` } });
  try {
    return await ctx.http.request<T>(withToken(await accessToken(ctx)));
  } catch (e) {
    if (!(e instanceof RemoteError) || e.status !== 401) throw e;
    return ctx.http.request<T>(withToken(await refreshAccessToken(ctx)));
  }
}

export function grantedScopes(ctx: AdapterContext): string[] {
  return stringSetting(ctx.connection.settings, "grantedScopes").split(/\s+/).filter(Boolean);
}

/** Shared completeAuthorization: exchange the code, identify the account, merge granted scopes into settings. */
export async function completeGoogleAuthorization(ctx: AdapterContext, p: { code: string; redirectUri: string; codeVerifier: string }, identify: (ctx: AdapterContext) => Promise<string | null>) {
  const { grantedScopes: scope } = await exchangeCode(ctx, p);
  let account: string | null = null;
  try {
    account = await identify(ctx);
  } catch (e) {
    ctx.log.warn("google: could not identify the account after authorization", { error: asRemoteError(e).message });
  }
  return { account, settings: { ...ctx.connection.settings, grantedScopes: scope } };
}
