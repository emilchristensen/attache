import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "../../src/app.ts";
import { startServer, type ServerHandle } from "../../src/http/server.ts";
import { createPairingCode, redeemPairingCode } from "../../src/http/security.ts";
import type { Clock } from "../../src/replication/clock.ts";

process.env.JARVIS_CREDENTIAL_STORE = "file";
process.env.JARVIS_NO_NOTIFY = "1";
// Coding-agent hooks are written under this home, never the real ~/.claude, ~/.codex or ~/.gemini.
process.env.JARVIS_AGENT_HOME ??= mkdtempSync(join(tmpdir(), "jarvis-it-home æøå-"));
// The command skills tell agents to run: the CLI from source, since tests have no bundle.
process.env.JARVIS_CLI_SCRIPT ??= join(import.meta.dirname, "../../src/main.ts");

/**
 * A new temporary folder whose path has a space and non-ASCII letters, as an
 * owner's folders often do ("C:\\Users\\Søren Ås"), so every test that uses the
 * harness shows that such paths work: in hook commands, git, the index and file watching.
 */
export function testFolder(name: string): string {
  return mkdtempSync(join(tmpdir(), `jarvis-it-${name} æøå-`));
}

export interface TestService {
  app: App;
  server: ServerHandle;
  url: string;
  token: string;
  stateDir: string;
  dataDir: string;
  call<T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }>;
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body?: unknown): Promise<T>;
  put<T = any>(path: string, body?: unknown): Promise<T>;
  waitJob(id: string, statuses?: string[], timeoutMs?: number): Promise<any>;
  stop(): Promise<void>;
}

export interface TestServiceOptions {
  stateDir?: string;
  dataDir?: string;
  setup?: boolean;
  features?: Record<string, boolean>;
  /** Drives Replication's timers; the real clock when left out. */
  clock?: Clock;
}

export async function startTestService(opts: TestServiceOptions = {}): Promise<TestService> {
  const stateDir = opts.stateDir ?? testFolder("state");
  const dataDir = opts.dataDir ?? join(testFolder("data"), "data");
  const app = new App({ stateDir, quiet: true, schedulerTickMs: 60_000, instance: `it-${Math.random().toString(36).slice(2, 8)}`, ...(opts.clock ? { clock: opts.clock } : {}) });
  const server = await startServer(app, { port: 0 });
  app.start();
  // What `jarvis serve` writes, so the CLI finds this service.
  writeFileSync(app.paths.runtimeFile, JSON.stringify({ pid: process.pid, port: server.port, url: server.url, version: "test", startedAt: app.startedAt, instance: app.instance }));
  const { code } = createPairingCode(app.db);
  const token = redeemPairingCode(app.db, code, { name: "test", kind: "cli" })!.token;
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${server.url}/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "x-jarvis-client": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // raw
    }
    return { status: res.status, body: parsed as any };
  };
  const ok = async (method: string, path: string, body?: unknown) => {
    const r = await call(method, path, body);
    if (r.status >= 400) throw new Error(`${method} ${path} → ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const svc: TestService = {
    app,
    server,
    url: server.url,
    token,
    stateDir,
    dataDir,
    call,
    get: (p) => ok("GET", p),
    post: (p, b = {}) => ok("POST", p, b),
    put: (p, b = {}) => ok("PUT", p, b),
    async waitJob(id, statuses = ["succeeded", "failed", "cancelled", "blocked"], timeoutMs = 20_000) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const r = await ok("GET", `/jobs/${id}`);
        if (statuses.includes(r.job.status)) return r;
        if (Date.now() > end) throw new Error(`job ${id} stuck in ${r.job.status}`);
        await new Promise((res) => setTimeout(res, 50));
      }
    },
    async stop() {
      await server.close();
      await app.stop();
      // What `jarvis serve` does on a clean stop, so the CLI sees the service as stopped.
      rmSync(app.paths.runtimeFile, { force: true });
    },
  };
  if (opts.setup !== false && !app.config.get().setupCompleted) {
    await svc.post("/setup/data-folder", { path: dataDir });
    if (opts.features) await svc.put("/features", { changes: opts.features, cascade: true });
    await svc.post("/setup/complete");
  }
  return svc;
}
