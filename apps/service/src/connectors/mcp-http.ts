/**
 * Minimal MCP client for the Streamable HTTP transport (JSON-RPC over POST,
 * answered as JSON or as a server-sent event stream). It implements what a
 * connector needs: initialize, tools/call and tools/list, with a session id,
 * one re-initialize when the server forgets the session, a token refresh on
 * 401, and classified errors so coverage never mistakes a failure for "empty".
 */
import type { CoverageState } from "@jarvis/contracts";
import { RemoteError, classifyStatus } from "./http.ts";
import { sleep } from "../platform/wait.ts";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpAuth {
  /** Value of the Authorization header for the next request. */
  header(): Promise<string>;
  /** Called once after a 401; return true when a fresh credential is available. */
  refresh?(): Promise<boolean>;
}

export interface McpToolResult {
  text: string;
  isError: boolean;
  structured: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PostResult {
  status: number;
  messages: JsonRpcResponse[];
  headers: Headers;
  text: string;
}


function parseSse(text: string): JsonRpcResponse[] {
  const out: JsonRpcResponse[] = [];
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) continue;
    try {
      out.push(JSON.parse(data) as JsonRpcResponse);
    } catch {
      // Keep-alive or non-JSON event.
    }
  }
  return out;
}

export class McpHttpClient {
  private sessionId: string | null = null;
  /** One handshake shared by concurrent calls; cleared when the server forgets the session. */
  private init: Promise<void> | null = null;
  private nextId = 1;
  private readonly host: string;
  private readonly url: string;
  private readonly auth: McpAuth;
  private readonly signal: AbortSignal;
  private readonly opts: { clientName?: string; timeoutMs?: number; baseDelayMs?: number };

  constructor(url: string, auth: McpAuth, signal: AbortSignal, opts: { clientName?: string; timeoutMs?: number; baseDelayMs?: number } = {}) {
    this.url = url;
    this.auth = auth;
    this.signal = signal;
    this.opts = opts;
    this.host = new URL(url).host;
  }

  private async post(body: Record<string, unknown>, retriedAuth = false): Promise<PostResult> {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    this.signal.addEventListener("abort", onAbort);
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 60_000);
    let res: Response;
    let text: string;
    // The timeout and cancellation cover the whole exchange, including a slow or stalled body (SSE).
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: await this.auth.header(),
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      text = await res.text();
    } catch (e) {
      if (this.signal.aborted) throw new RemoteError("Cancelled", "error");
      if (ctrl.signal.aborted) throw new RemoteError(`${this.host} did not answer within ${Math.round((this.opts.timeoutMs ?? 60_000) / 1000)} seconds`, "offline");
      if (e instanceof RemoteError) throw e;
      throw new RemoteError(`Network error contacting ${this.host}: ${(e as Error).message}`, "offline");
    } finally {
      clearTimeout(timer);
      this.signal.removeEventListener("abort", onAbort);
    }
    if (res.status === 401 && !retriedAuth && this.auth.refresh && (await this.auth.refresh())) return this.post(body, true);
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!res.ok && res.status !== 202) return { status: res.status, messages: [], headers: res.headers, text };
    const type = res.headers.get("content-type") ?? "";
    let messages: JsonRpcResponse[] = [];
    if (type.includes("text/event-stream")) messages = parseSse(text);
    else if (text.trim()) {
      try {
        const parsed = JSON.parse(text) as JsonRpcResponse | JsonRpcResponse[];
        messages = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        throw new RemoteError(`Malformed MCP response from ${this.host}`, "error", res.status);
      }
    }
    return { status: res.status, messages, headers: res.headers, text };
  }

  private httpError(status: number, headers: Headers, text: string, method: string): RemoteError {
    const state = classifyStatus(status, headers, text);
    const hint = status === 401 ? " Sign in again or check the API token." : status === 403 ? " Your account or organization does not allow this (an admin may need to enable the Atlassian MCP server or API-token access)." : "";
    return new RemoteError(`MCP ${method} → HTTP ${status}.${hint}`, state, status);
  }

  private async rpc(method: string, params: Record<string, unknown>, opts: { retries: number }): Promise<unknown> {
    let attempt = 0;
    let reinitialized = false;
    for (;;) {
      if (method !== "initialize") await this.initialize();
      const id = this.nextId++;
      const r = await this.post({ jsonrpc: "2.0", id, method, params });
      if (r.status === 404 && this.sessionId && !reinitialized && method !== "initialize") {
        // The server dropped our session: start a new one and repeat the request once.
        this.sessionId = null;
        this.init = null;
        reinitialized = true;
        continue;
      }
      if (r.status >= 400) {
        const err = this.httpError(r.status, r.headers, r.text, method);
        if ((r.status === 429 || r.status >= 500) && attempt < opts.retries) {
          await sleep((this.opts.baseDelayMs ?? 500) * 2 ** attempt++);
          continue;
        }
        throw err;
      }
      const msg = r.messages.find((m) => m.id === id);
      if (!msg) throw new RemoteError(`MCP ${method}: no response from ${this.host}`, "error");
      if (msg.error) throw new RemoteError(`MCP ${method} failed: ${msg.error.message}`, "error");
      return msg.result;
    }
  }

  initialize(): Promise<void> {
    this.init ??= (async () => {
      await this.rpc("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: this.opts.clientName ?? "jarvis", version: "0.1" } }, { retries: 1 });
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    })().catch((e) => {
      this.init = null;
      throw e;
    });
    return this.init;
  }


  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    const r = (await this.rpc("tools/list", {}, { retries: 2 })) as { tools?: Array<{ name: string }> };
    return r.tools ?? [];
  }

  /** Call a tool. Reads may be retried on 429/5xx; writes pass retries 0. */
  async callTool(name: string, args: Record<string, unknown>, opts: { retries?: number } = {}): Promise<McpToolResult> {
    const r = (await this.rpc("tools/call", { name, arguments: args }, { retries: opts.retries ?? 2 })) as { content?: Array<{ type: string; text?: string }>; isError?: boolean; structuredContent?: unknown };
    const text = (r.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
    return { text, isError: !!r.isError, structured: r.structuredContent ?? null };
  }
}

/** Coverage state for an error a tool reported in its result (Atlassian embeds an HTTP status code). */
export function toolErrorState(statusCode: number | null, message: string): CoverageState {
  if (statusCode === 401 || /missing the scope|unauthori[sz]ed|invalid.token/i.test(message)) return "unauthorized";
  if (statusCode === 403 || /forbidden|not permitted|permission/i.test(message)) return "denied";
  if (statusCode === 429 || /rate.?limit/i.test(message)) return "partial";
  if (statusCode !== null && statusCode >= 500) return "offline";
  return "error";
}
