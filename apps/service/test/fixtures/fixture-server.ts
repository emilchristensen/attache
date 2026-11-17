/**
 * TEST-ONLY fixture server emulating remote APIs (pagination, errors, rate
 * limits). It is never started by the service in normal operation; the
 * service only talks to it when ATTACHE_TEST_ENDPOINTS=1 and a connection's
 * endpoint override points here. Results produced against it are fixture
 * results, never live integration evidence.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: unknown;
  rawBody: string;
}

export interface FixtureResponse {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  text?: string;
  /** Raw bytes, for file downloads. */
  body?: Uint8Array;
}

export type FixtureHandler = (req: FixtureRequest) => FixtureResponse | Promise<FixtureResponse>;

export interface FixtureServer {
  url: string;
  requests: FixtureRequest[];
  route(method: string, path: string | RegExp, handler: FixtureHandler): void;
  reset(): void;
  close(): Promise<void>;
}

export async function startFixtureServer(port = 0): Promise<FixtureServer> {
  const routes: Array<{ method: string; path: string | RegExp; handler: FixtureHandler }> = [];
  const requests: FixtureRequest[] = [];
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const rawBody = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url ?? "/", "http://fixture");
    let body: unknown = rawBody;
    if ((req.headers["content-type"] ?? "").includes("json") && rawBody) body = JSON.parse(rawBody);
    else if ((req.headers["content-type"] ?? "").includes("x-www-form-urlencoded")) body = Object.fromEntries(new URLSearchParams(rawBody));
    const freq: FixtureRequest = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, body, rawBody };
    requests.push(freq);
    const route = [...routes].reverse().find((r) => r.method === freq.method && (typeof r.path === "string" ? r.path === freq.path : r.path.test(freq.path)));
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: `No fixture for ${freq.method} ${freq.path}` }));
      return;
    }
    try {
      const out = await route.handler(freq);
      const type = out.json !== undefined ? "application/json" : out.body !== undefined ? "application/octet-stream" : "text/plain";
      const headers = { "content-type": type, ...(out.body !== undefined ? { "content-length": String(out.body.length) } : {}), ...(out.headers ?? {}) };
      res.writeHead(out.status ?? 200, headers);
      res.end(out.json !== undefined ? JSON.stringify(out.json) : (out.body ?? out.text ?? ""));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: (e as Error).message }));
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    requests,
    route(method, path, handler) {
      routes.push({ method, path, handler });
    },
    reset() {
      routes.length = 0;
      requests.length = 0;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
