import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError, type ZodType } from "zod";
import type { ClientIdentity } from "./security.ts";

export class HttpError extends Error {
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

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  client: ClientIdentity | null;
  body<T>(schema: ZodType<T>): Promise<T>;
  raw(limitBytes: number): Promise<Buffer>;
  query(name: string): string | null;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
  public: boolean;
}

export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: Handler, opts: { public?: boolean } = {}) {
    this.routes.push({ method, parts: path.split("/").filter(Boolean), handler, public: !!opts.public });
  }
  get(p: string, h: Handler, o?: { public?: boolean }) {
    this.add("GET", p, h, o);
  }
  post(p: string, h: Handler, o?: { public?: boolean }) {
    this.add("POST", p, h, o);
  }
  put(p: string, h: Handler, o?: { public?: boolean }) {
    this.add("PUT", p, h, o);
  }
  patch(p: string, h: Handler, o?: { public?: boolean }) {
    this.add("PATCH", p, h, o);
  }
  delete(p: string, h: Handler, o?: { public?: boolean }) {
    this.add("DELETE", p, h, o);
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    const parts = pathname.split("/").filter(Boolean);
    for (const r of this.routes) {
      if (r.method !== method || r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const rp = r.parts[i]!;
        if (rp.startsWith(":")) params[rp.slice(1)] = decodeURIComponent(parts[i]!);
        else if (rp !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { route: r, params };
    }
    return null;
  }
}

export async function readBody(req: IncomingMessage, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limitBytes) throw new HttpError(413, "too_large", `Request body exceeds ${limitBytes} bytes`);
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

export function makeCtx(req: IncomingMessage, res: ServerResponse, url: URL, params: Record<string, string>, client: ClientIdentity | null): Ctx {
  let cached: Buffer | null = null;
  const raw = async (limit: number) => (cached ??= await readBody(req, limit));
  return {
    req,
    res,
    url,
    params,
    client,
    raw,
    query: (n) => url.searchParams.get(n),
    async body<T>(schema: ZodType<T>): Promise<T> {
      const buf = await raw(2 * 1024 * 1024);
      let data: unknown = {};
      if (buf.length) {
        try {
          data = JSON.parse(buf.toString("utf8"));
        } catch {
          throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
        }
      }
      try {
        return schema.parse(data);
      } catch (e) {
        if (e instanceof ZodError) throw new HttpError(400, "invalid_request", "Request did not match the expected shape", e.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
        throw e;
      }
    },
  };
}
