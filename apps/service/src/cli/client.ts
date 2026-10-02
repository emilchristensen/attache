import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { API_PREFIX } from "@jarvis/contracts";
import type { ServicePaths } from "../core/paths.ts";
import { openDb } from "../core/db.ts";
import { createPairingCode } from "../http/security.ts";

export interface Runtime {
  pid: number;
  port: number;
  url: string;
  version: string;
  startedAt: string;
  instance: string;
}

export function readRuntime(file: string): Runtime | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Runtime;
  } catch {
    return null;
  }
}

export function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * The CLI as a paired client of the running service. Memory writes go through
 * the service, which owns the data folder; the CLI pairs itself the first time
 * (the same trust as `jarvis pair`) and keeps its token in the state folder.
 */
export class ServiceClient {
  private readonly paths: ServicePaths;
  private readonly base: string;

  constructor(paths: ServicePaths) {
    this.paths = paths;
    const rt = readRuntime(paths.runtimeFile);
    if (!rt || !alive(rt.pid)) throw new ServiceError(503, "not_running", "Jarvis is not running. Start it with `jarvis start`, then try again.");
    this.base = rt.url;
  }

  private get tokenFile() {
    return join(this.paths.stateDir, "cli-token");
  }

  async get<T>(path: string): Promise<T> {
    return this.call<T>("GET", path);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return this.call<T>("POST", path, body);
  }

  private async call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const token = existsSync(this.tokenFile) ? readFileSync(this.tokenFile, "utf8").trim() : await this.pair();
    const res = await this.fetch(method, path, token, body);
    // A revoked or restored-over token: pair again once.
    if (res.status === 401 && !retried) {
      rmSync(this.tokenFile, { force: true });
      return this.call<T>(method, path, body, true);
    }
    const parsed = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    if (!res.ok) throw new ServiceError(res.status, parsed?.error?.code ?? "error", parsed?.error?.message ?? `Jarvis answered ${res.status}`);
    return parsed as T;
  }

  private async fetch(method: string, path: string, token: string | null, body?: unknown): Promise<Response> {
    try {
      return await fetch(`${this.base}${API_PREFIX}${path}`, {
        method,
        headers: { "x-jarvis-client": "1", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new ServiceError(503, "unreachable", `Could not reach Jarvis at ${this.base}: ${(e as Error).message}`);
    }
  }

  private async pair(): Promise<string> {
    const db = openDb(this.paths.dbFile);
    let code: string;
    try {
      code = createPairingCode(db, "cli").code;
    } finally {
      db.close();
    }
    const res = await this.fetch("POST", "/pair", null, { code, clientName: "Jarvis CLI", kind: "cli" });
    const out = (await res.json().catch(() => null)) as { token?: string; error?: { message?: string } } | null;
    if (!res.ok || !out?.token) throw new ServiceError(res.status, "pairing_failed", `The CLI could not pair with Jarvis: ${out?.error?.message ?? res.status}`);
    const tmp = join(dirname(this.tokenFile), `.${randomUUID()}.tmp`);
    writeFileSync(tmp, out.token, { mode: 0o600 });
    renameSync(tmp, this.tokenFile);
    return out.token;
  }
}
