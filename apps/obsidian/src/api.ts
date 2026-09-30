import { requestUrl } from "obsidian";

export class JarvisApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Minimal client for the Jarvis service API. Uses Obsidian's requestUrl, so it
 * works from the desktop app without browser CORS rules. The token lives in
 * Obsidian SecretStorage, never in the vault's plugin data.
 */
export class JarvisClient {
  baseUrl: string;
  token: string | null;

  constructor(baseUrl: string, token: string | null) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.token = token;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res;
    try {
      res = await requestUrl({
        url: `${this.baseUrl}/api/v1${path}`,
        method,
        headers: {
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
          ...(method !== "GET" ? { "x-jarvis-client": "1" } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        throw: false,
      });
    } catch (e) {
      throw new JarvisApiError(0, "offline", `The Jarvis service is not reachable at ${this.baseUrl}. Is it installed and running? (${(e as Error).message})`);
    }
    let data: unknown = null;
    try {
      data = res.json;
    } catch {
      data = res.text;
    }
    if (res.status >= 400) {
      const err = (data as { error?: { code?: string; message?: string } })?.error;
      throw new JarvisApiError(res.status, err?.code ?? "http_error", err?.message ?? `Request failed (${res.status})`);
    }
    return data as T;
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body: unknown = {}) {
    return this.request<T>("POST", path, body);
  }
}

export interface Citation {
  marker: string;
  root: string;
  relPath: string;
  title: string;
  startLine: number;
  endLine: number;
  snippet: string;
  section: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  status: "streaming" | "complete" | "error" | "cancelled";
  citations: Citation[];
  retrieval: { hits: number; supported: boolean; mode: string } | null;
  error: string | null;
}

export interface AttentionItem {
  id: string;
  key: string;
  kind: string;
  title: string;
  summary: string;
  url: string | null;
  sourceKind: string;
  dueAt: string | null;
  evidence: Array<{ label: string; relPath?: string; lines?: [number, number] }>;
  connectionId: string | null;
}
