import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { API_PREFIX } from "@jarvis/contracts";
import type { App } from "../app.ts";
import { redact } from "../core/log.ts";
import { HttpError, makeCtx, Router } from "./router.ts";
import { allowedOrigins, authenticate, hostAllowed, originAllowed } from "./security.ts";
import { registerRoutes } from "./routes.ts";
import { PolicyError } from "../memory/policy.ts";
import { ActionError } from "../actions/service.ts";
import { RemoteError } from "../connectors/http.ts";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export interface ServerHandle {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  const payload = body === undefined ? "" : JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(payload);
}

function errorResponse(e: unknown): { status: number; body: { error: { code: string; message: string; details?: unknown } } } {
  if (e instanceof HttpError) return { status: e.status, body: { error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } } };
  if (e instanceof PolicyError) return { status: e.code === "protected" || e.code === "actor_denied" ? 403 : 400, body: { error: { code: e.code, message: e.message } } };
  if (e instanceof ActionError) return { status: e.status, body: { error: { code: e.code, message: e.message } } };
  if (e instanceof RemoteError) return { status: e.state === "unauthorized" ? 401 : e.state === "denied" ? 403 : e.state === "offline" ? 503 : 422, body: { error: { code: `remote_${e.state}`, message: e.message } } };
  const msg = (e as Error)?.message ?? "Internal error";
  if (msg === "not_found") return { status: 404, body: { error: { code: "not_found", message: "Not found" } } };
  return { status: 500, body: { error: { code: "internal", message: redact(msg) } } };
}

export function webDir(): string | null {
  const candidates = [process.env.JARVIS_WEB_DIR, join(import.meta.dirname ?? ".", "web"), join(import.meta.dirname ?? ".", "../../web/dist"), join(import.meta.dirname ?? ".", "../../../web/dist")].filter(Boolean) as string[];
  return candidates.map((c) => resolve(c)).find((c) => existsSync(join(c, "index.html"))) ?? null;
}

function serveStatic(root: string, pathname: string, res: ServerResponse): boolean {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, "");
  let file = resolve(root, rel);
  if (!file.startsWith(root)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) {
    if (extname(rel)) return false;
    file = join(root, "index.html"); // client-side routes
  }
  const ext = extname(file);
  const immutable = /\/assets\//.test(file);
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
  });
  res.end(readFileSync(file));
  return true;
}

export async function startServer(app: App, opts: { port: number; host?: string }): Promise<ServerHandle> {
  const router = new Router();
  let port = opts.port;
  registerRoutes(router, app, () => port);
  const web = webDir();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!hostAllowed(req, port)) {
        send(res, 421, { error: { code: "bad_host", message: "Jarvis only answers on 127.0.0.1" } });
        return;
      }
      const origin = req.headers.origin;
      if (!originAllowed(req, port)) {
        send(res, 403, { error: { code: "bad_origin", message: "Origin not allowed" } });
        return;
      }
      const cors: Record<string, string> = origin && allowedOrigins(port).has(origin) ? { "access-control-allow-origin": origin, "access-control-allow-credentials": "true", vary: "Origin" } : {};
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...cors, "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE", "access-control-allow-headers": "authorization, content-type, x-jarvis-client, last-event-id", "access-control-max-age": "600" });
        res.end();
        return;
      }
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      if (!url.pathname.startsWith(API_PREFIX + "/") && url.pathname !== API_PREFIX) {
        if (req.method === "GET" && web && serveStatic(web, url.pathname, res)) return;
        if (req.method === "GET" && !web) {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
          res.end("Jarvis service is running, but the web client is not installed.");
          return;
        }
        send(res, 404, { error: { code: "not_found", message: "Not found" } });
        return;
      }
      const path = url.pathname.slice(API_PREFIX.length) || "/";
      const m = router.match(req.method ?? "GET", path);
      if (!m) {
        send(res, 404, { error: { code: "not_found", message: `No route ${req.method} ${path}` } }, cors);
        return;
      }
      const client = authenticate(app.db, req);
      if (!m.route.public && !client) {
        send(res, 401, { error: { code: "unauthenticated", message: "Pair this client with Jarvis first." } }, cors);
        return;
      }
      // CSRF: state-changing requests must carry a header a cross-site form cannot set.
      if (req.method !== "GET" && req.headers["x-jarvis-client"] !== "1") {
        send(res, 403, { error: { code: "csrf", message: "Missing X-Jarvis-Client header" } }, cors);
        return;
      }
      const ctx = makeCtx(req, res, url, m.params, client);
      const out = await m.route.handler(ctx);
      if (res.headersSent || res.writableEnded) return;
      if (out && typeof out === "object" && "__raw" in (out as Record<string, unknown>)) {
        const r = out as { __raw: Buffer; mime: string; status?: number; headers?: Record<string, string> };
        res.writeHead(r.status ?? 200, { "content-type": r.mime, "cache-control": "no-store", ...cors, ...(r.headers ?? {}) });
        res.end(r.__raw);
        return;
      }
      if (out && typeof out === "object" && "__status" in (out as Record<string, unknown>)) {
        const r = out as { __status: number; body: unknown; headers?: Record<string, string> };
        send(res, r.__status, r.body, { ...cors, ...(r.headers ?? {}) });
        return;
      }
      send(res, 200, out ?? { ok: true }, cors);
    } catch (e) {
      const { status, body } = errorResponse(e);
      if (status >= 500) app.log.error("request failed", { method: req.method, url: req.url, error: (e as Error).message, stack: (e as Error).stack });
      send(res, status, body);
    }
  });
  server.keepAliveTimeout = 65_000;
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", () => resolveListen());
  });
  port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
