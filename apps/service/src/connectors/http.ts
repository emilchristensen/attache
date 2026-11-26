import type { CoverageState } from "@attache/contracts";
import { redact } from "../core/log.ts";

/** A failed remote call, classified so coverage never confuses failure with emptiness. */
export class RemoteError extends Error {
  readonly state: CoverageState;
  readonly status: number | null;
  readonly retryAfterMs: number | null;
  constructor(message: string, state: CoverageState, status: number | null = null, retryAfterMs: number | null = null) {
    super(redact(message));
    this.state = state;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface HttpRequest {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  form?: Record<string, string>;
  timeoutMs?: number;
  /** Retries for 429/5xx/network errors on idempotent calls. Writes pass 0. */
  retries?: number;
  /** "bytes": `data` is the body's exact bytes (a signed file, a download) instead of parsed JSON or text. */
  responseType?: "bytes";
}

export interface HttpResponse<T = unknown> {
  status: number;
  headers: Headers;
  data: T;
}

export interface HttpClient {
  request<T = unknown>(req: HttpRequest): Promise<HttpResponse<T>>;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new RemoteError("Cancelled", "error"));
    });
  });

export function classifyStatus(status: number, headers: Headers, bodyText: string): CoverageState {
  if (status === 401) return "unauthorized";
  if (status === 403) {
    if (headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(bodyText)) return "partial";
    return "denied";
  }
  if (status === 429) return "partial";
  if (status === 404) return "error";
  if (status >= 500) return "offline";
  return "error";
}

function retryAfter(headers: Headers): number | null {
  const ra = headers.get("retry-after");
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, 30_000);
    const at = Date.parse(ra);
    if (Number.isFinite(at)) return Math.max(0, Math.min(at - Date.now(), 30_000));
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset && headers.get("x-ratelimit-remaining") === "0") return Math.max(0, Math.min(Number(reset) * 1000 - Date.now(), 30_000));
  return null;
}

export function createHttpClient(opts: { signal?: AbortSignal; baseDelayMs?: number; userAgent?: string } = {}): HttpClient {
  const baseDelay = opts.baseDelayMs ?? 500;
  return {
    async request<T>(req: HttpRequest): Promise<HttpResponse<T>> {
      const retries = req.retries ?? ((req.method ?? "GET") === "GET" ? 3 : 0);
      let attempt = 0;
      for (;;) {
        const ctrl = new AbortController();
        const onAbort = () => ctrl.abort();
        opts.signal?.addEventListener("abort", onAbort);
        const timer = setTimeout(() => ctrl.abort(), req.timeoutMs ?? 20_000);
        let res: Response;
        try {
          const headers: Record<string, string> = { "user-agent": opts.userAgent ?? "Attache/0.1 (local)", accept: "application/json", ...(req.headers ?? {}) };
          let body: string | undefined;
          if (req.form) {
            headers["content-type"] = "application/x-www-form-urlencoded";
            body = new URLSearchParams(req.form).toString();
          } else if (req.body !== undefined) {
            headers["content-type"] = "application/json";
            body = JSON.stringify(req.body);
          }
          res = await fetch(req.url, { method: req.method ?? "GET", headers, ...(body !== undefined ? { body } : {}), signal: ctrl.signal });
        } catch (e) {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          if (opts.signal?.aborted) throw new RemoteError("Cancelled", "error");
          if (attempt < retries) {
            await sleep(baseDelay * 2 ** attempt++, opts.signal);
            continue;
          }
          throw new RemoteError(`Network error contacting ${new URL(req.url).host}: ${(e as Error).message}`, "offline");
        }
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        const bytes = Buffer.from(await res.arrayBuffer());
        // As `Response.text()` decodes: UTF-8, without a leading byte order mark.
        const text = new TextDecoder().decode(bytes);
        if (res.ok) {
          if (req.responseType === "bytes") return { status: res.status, headers: res.headers, data: bytes as T };
          let data: unknown = text;
          if (text && (res.headers.get("content-type") ?? "").includes("json")) {
            try {
              data = JSON.parse(text);
            } catch {
              throw new RemoteError(`Malformed JSON from ${new URL(req.url).host}`, "error", res.status);
            }
          }
          return { status: res.status, headers: res.headers, data: data as T };
        }
        const state = classifyStatus(res.status, res.headers, text);
        const wait = retryAfter(res.headers);
        const retryable = res.status === 429 || res.status >= 500 || (res.status === 403 && state === "partial");
        if (retryable && attempt < retries) {
          await sleep(wait ?? baseDelay * 2 ** attempt, opts.signal);
          attempt++;
          continue;
        }
        throw new RemoteError(`${req.method ?? "GET"} ${new URL(req.url).pathname} → HTTP ${res.status}: ${text.slice(0, 300)}`, state, res.status, wait);
      }
    },
  };
}

/**
 * Follow pagination and record whether the listing is complete. A page cap,
 * rate limit or failure after the first page marks the scope partial rather
 * than silently returning what was read so far as the whole result.
 */
export async function paginate<T>(
  fetchPage: (cursor: string | null) => Promise<{ items: T[]; next: string | null }>,
  opts: { maxPages: number },
): Promise<{ items: T[]; pages: number; complete: boolean; error: RemoteError | null }> {
  const items: T[] = [];
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    try {
      const page = await fetchPage(cursor);
      pages++;
      items.push(...page.items);
      if (!page.next) return { items, pages, complete: true, error: null };
      if (pages >= opts.maxPages) return { items, pages, complete: false, error: null };
      cursor = page.next;
    } catch (e) {
      const err = e instanceof RemoteError ? e : new RemoteError((e as Error).message, "error");
      if (pages === 0) throw err;
      return { items, pages, complete: false, error: err };
    }
  }
}

/**
 * Run a read-back after a write already succeeded. A failure here must not be
 * reported as a failed write (the effect exists); it only leaves it unverified.
 */
export async function afterWrite<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

/** Parse an RFC 5988 Link header and return the rel="next" URL. */
export function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim());
    if (m) return m[1]!;
  }
  return null;
}
