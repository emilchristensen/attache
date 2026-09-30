export const API_PREFIX = "/api/v1";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Thin client for the versioned service API. The session is an HttpOnly cookie set at pairing. */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string>; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_PREFIX}${path}`, {
      method: init.method ?? (init.body !== undefined || init.raw !== undefined ? "POST" : "GET"),
      credentials: "same-origin",
      headers: {
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.method && init.method !== "GET" ? { "x-jarvis-client": "1" } : init.body !== undefined || init.raw !== undefined ? { "x-jarvis-client": "1" } : {}),
        ...(init.headers ?? {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : init.raw !== undefined ? { body: init.raw } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "offline", "Jarvis service is not reachable. Is it running?");
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    let body: { error?: { code?: string; message?: string; details?: unknown } } = {};
    try {
      body = await res.json();
    } catch {
      // not JSON
    }
    throw new ApiError(res.status, body.error?.code ?? "http_error", body.error?.message ?? `Request failed (${res.status})`, body.error?.details);
  }
  if (type.includes("application/json")) return (await res.json()) as T;
  return (await res.blob()) as unknown as T;
}

export const post = <T = unknown>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", body });
export const put = <T = unknown>(path: string, body: unknown = {}) => api<T>(path, { method: "PUT", body });
export const patch = <T = unknown>(path: string, body: unknown = {}) => api<T>(path, { method: "PATCH", body });
export const del = <T = unknown>(path: string) => api<T>(path, { method: "DELETE" });
