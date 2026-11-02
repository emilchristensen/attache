/**
 * TEST-ONLY emulation of the Atlassian Rovo MCP server and its OAuth 2.1
 * authorization server: Streamable HTTP JSON-RPC with session ids (JSON or
 * SSE answers), RFC 9728/8414 discovery, dynamic client registration, PKCE
 * authorization code and refresh grants. Tools are supplied by the test.
 */
import { createHash } from "node:crypto";
import type { FixtureRequest, FixtureResponse, FixtureServer } from "./fixture-server.ts";

export const MCP_PREFIX = "/atlassian-mcp";
export const AUTH_PREFIX = "/atlassian-auth";

export type McpTool = (args: Record<string, unknown>, req: FixtureRequest) => unknown;

export interface AtlassianFixture {
  tools: Map<string, McpTool>;
  /** Basic credentials accepted as an API token: "email:token". */
  apiTokens: Set<string>;
  accessTokens: Set<string>;
  refreshTokens: Set<string>;
  clients: Map<string, { redirectUris: string[] }>;
  codes: Map<string, { clientId: string; challenge: string; redirectUri: string; scope: string; resource: string }>;
  sessions: Set<string>;
  /** Answer tools/call as an SSE stream instead of JSON. */
  sse: boolean;
  /** Forget every session once (the client must re-initialize). */
  dropSessions: boolean;
  calls: Array<{ name: string; args: Record<string, unknown> }>;
  /** HTTP statuses to answer the next tools/call requests with, in order. */
  failNext: number[];
  issued: number;
}

/** A tool-level error the way the Atlassian server reports it (HTTP 200, isError). */
export class ToolError extends Error {
  readonly statusCode: number;
  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
  }
}

function rpcResult(f: AtlassianFixture, id: unknown, result: unknown, headers: Record<string, string> = {}): FixtureResponse {
  const body = { jsonrpc: "2.0", id, result };
  if (f.sse) return { status: 200, headers: { "content-type": "text/event-stream", ...headers }, text: `event: message\ndata: ${JSON.stringify(body)}\n\n` };
  return { status: 200, headers: { "content-type": "application/json", ...headers }, text: JSON.stringify(body) };
}

function authorized(f: AtlassianFixture, req: FixtureRequest): boolean {
  const h = String(req.headers.authorization ?? "");
  if (h.startsWith("Bearer ")) return f.accessTokens.has(h.slice(7));
  if (h.startsWith("Basic ")) return f.apiTokens.has(Buffer.from(h.slice(6), "base64").toString("utf8"));
  return false;
}

export function mountAtlassianMcp(fx: FixtureServer): AtlassianFixture {
  const f: AtlassianFixture = { tools: new Map(), apiTokens: new Set(), accessTokens: new Set(), refreshTokens: new Set(), clients: new Map(), codes: new Map(), sessions: new Set(), sse: false, dropSessions: false, calls: [], failNext: [], issued: 0 };
  const issuer = () => `${fx.url}${AUTH_PREFIX}/tenant`;
  const resource = () => `${fx.url}${MCP_PREFIX}/v2/mcp`;

  fx.route("GET", `/.well-known/oauth-protected-resource${MCP_PREFIX}/v2/mcp`, () => ({ json: { resource: resource(), authorization_servers: [issuer()], bearer_methods_supported: ["header"] } }));
  fx.route("GET", `/.well-known/oauth-authorization-server${AUTH_PREFIX}/tenant`, () => ({
    json: { issuer: issuer(), authorization_endpoint: `${fx.url}${AUTH_PREFIX}/authorize`, token_endpoint: `${fx.url}${AUTH_PREFIX}/oauth/token`, registration_endpoint: `${issuer()}/dcr/register`, code_challenge_methods_supported: ["S256"] },
  }));
  fx.route("POST", `${AUTH_PREFIX}/tenant/dcr/register`, (req) => {
    const b = req.body as { redirect_uris?: string[] };
    const id = `client-${f.clients.size + 1}`;
    f.clients.set(id, { redirectUris: b.redirect_uris ?? [] });
    return { status: 201, json: { client_id: id, redirect_uris: b.redirect_uris, token_endpoint_auth_method: "none" } };
  });
  fx.route("GET", `${AUTH_PREFIX}/authorize`, (req) => {
    const q = req.query;
    const client = f.clients.get(q.get("client_id") ?? "");
    const redirect = q.get("redirect_uri") ?? "";
    if (!client || !client.redirectUris.includes(redirect)) return { status: 400, json: { error: "invalid_client" } };
    if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge") || q.get("resource") !== resource()) return { status: 400, json: { error: "invalid_request" } };
    const code = `code-${f.codes.size + 1}`;
    f.codes.set(code, { clientId: q.get("client_id")!, challenge: q.get("code_challenge")!, redirectUri: redirect, scope: q.get("scope") ?? "", resource: q.get("resource")! });
    const to = new URL(redirect);
    to.searchParams.set("code", code);
    to.searchParams.set("state", q.get("state") ?? "");
    return { status: 302, headers: { location: to.toString() }, text: "" };
  });
  fx.route("POST", `${AUTH_PREFIX}/oauth/token`, (req) => {
    const form = req.body as Record<string, string>;
    const issue = (scope: string) => {
      const access = `atl-access-${++f.issued}`;
      const refresh = `atl-refresh-${f.issued}`;
      f.accessTokens.add(access);
      f.refreshTokens.add(refresh);
      return { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: "Bearer", scope };
    };
    if (form.grant_type === "authorization_code") {
      const c = f.codes.get(form.code ?? "");
      f.codes.delete(form.code ?? "");
      const verifierOk = !!c && createHash("sha256").update(form.code_verifier ?? "").digest("base64url") === c.challenge;
      if (!c || !verifierOk || c.clientId !== form.client_id || c.redirectUri !== form.redirect_uri || c.resource !== form.resource) return { status: 400, json: { error: "invalid_grant" } };
      return { json: issue(c.scope) };
    }
    if (form.grant_type === "refresh_token") {
      if (!f.refreshTokens.has(form.refresh_token ?? "")) return { status: 400, json: { error: "invalid_grant" } };
      f.refreshTokens.delete(form.refresh_token!);
      return { json: issue("read:jira:agent-interface") };
    }
    return { status: 400, json: { error: "unsupported_grant_type" } };
  });

  fx.route("POST", `${MCP_PREFIX}/v2/mcp`, async (req) => {
    if (!authorized(f, req)) return { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${fx.url}/.well-known/oauth-protected-resource${MCP_PREFIX}/v2/mcp"` }, json: { error: "invalid_token" } };
    const b = req.body as { id?: unknown; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };
    if (b.method === "initialize") {
      const sid = `sess-${f.sessions.size + 1}-${Date.now()}`;
      f.sessions.add(sid);
      return rpcResult(f, b.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "atlassian-fixture", version: "0" } }, { "mcp-session-id": sid });
    }
    const sid = String(req.headers["mcp-session-id"] ?? "");
    if (f.dropSessions) {
      f.dropSessions = false;
      f.sessions.clear();
    }
    if (!f.sessions.has(sid)) return { status: 404, json: { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" } } };
    if (b.method === "notifications/initialized") return { status: 202, text: "" };
    if (b.method === "tools/list") return rpcResult(f, b.id, { tools: [...f.tools.keys()].map((name) => ({ name, inputSchema: { type: "object" } })) });
    if (b.method === "tools/call") {
      const fail = f.failNext.shift();
      if (fail) return { status: fail, headers: { "retry-after": "0" }, json: { error: "fixture failure" } };
      const name = b.params?.name ?? "";
      const args = b.params?.arguments ?? {};
      f.calls.push({ name, args });
      const tool = f.tools.get(name);
      if (!tool) return rpcResult(f, b.id, { content: [{ type: "text", text: JSON.stringify({ error: true, message: `Unknown tool ${name}`, statusCode: 404 }) }], isError: true });
      try {
        const out = await tool(args, req);
        return rpcResult(f, b.id, { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }], isError: false });
      } catch (e) {
        const status = e instanceof ToolError ? e.statusCode : 500;
        return rpcResult(f, b.id, { content: [{ type: "text", text: JSON.stringify({ error: true, message: (e as Error).message, statusCode: status }) }], isError: true });
      }
    }
    return { status: 200, json: { jsonrpc: "2.0", id: b.id, error: { code: -32601, message: "Method not found" } } };
  });
  return f;
}

/** Route executeRead/executeWrite by operation name to plain handlers. */
export function executeOps(f: AtlassianFixture, ops: Record<string, McpTool>): void {
  const run: McpTool = (args, req) => {
    const op = ops[String(args.name ?? "")];
    if (!op) throw new ToolError(`Unknown operation ${String(args.name)}`, 404);
    return op((args.inputs ?? {}) as Record<string, unknown>, req);
  };
  f.tools.set("executeRead", run);
  f.tools.set("executeWrite", run);
}
