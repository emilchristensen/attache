/**
 * TEST-ONLY: the `jarvis` executable started from source as a child process,
 * optionally as if on another operating system, with a paired API client,
 * and a GitHub stand-in that asks for reviews.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempDir } from "../helpers.ts";
import { startFixtureServer, type FixtureServer } from "./fixture-server.ts";

export const MAIN = join(import.meta.dirname, "../../src/main.ts");
/** A URL, because `--import` reads a Windows path's drive letter as a URL scheme. */
export const FAKE_PLATFORM = pathToFileURL(join(import.meta.dirname, "fake-platform.mjs")).href;

export type EnvChanges = Record<string, string | undefined>;

/** This process's environment with `changes` applied; undefined removes a variable. */
export function childEnv(changes: EnvChanges): NodeJS.ProcessEnv {
  const out = { ...process.env, ...changes };
  for (const [k, v] of Object.entries(changes)) if (v === undefined) delete out[k];
  return out;
}

/** Run a `jarvis` command to completion. `JARVIS_TEST_FAKE_PLATFORM` in `env` picks the operating system it sees. */
export function jarvisCli(args: string[], env: EnvChanges) {
  return spawnSync(process.execPath, ["--import", FAKE_PLATFORM, MAIN, ...args], { env: childEnv(env), encoding: "utf8", timeout: 60_000 });
}

export interface ChildService {
  stateDir: string;
  api<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  /** The service log so far. */
  log(): string;
  stop(): Promise<void>;
}

/** A fresh state folder, with room beside it for a data folder. */
export function newStateDir(): string {
  const dir = join(tempDir("jarvis-child-"), "state");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Every child started here; kill them after each test. */
export const runningChildren: ChildProcess[] = [];

/** Start `jarvis serve`, pair a client and finish setup on first start. */
export async function serveChild(stateDir: string, env: EnvChanges): Promise<ChildService> {
  const child = spawn(process.execPath, ["--import", FAKE_PLATFORM, MAIN, "serve", "--state-dir", stateDir, "--port", "0"], { env: childEnv(env), stdio: "ignore" });
  runningChildren.push(child);
  let url = "";
  for (let i = 0; i < 600 && !url; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const rt = join(stateDir, "runtime.json");
    if (existsSync(rt)) {
      const j = JSON.parse(readFileSync(rt, "utf8"));
      if (j.pid === child.pid) url = j.url;
    }
  }
  if (!url) throw new Error("service did not start");
  const { code } = JSON.parse(jarvisCli(["pair", "--state-dir", stateDir, "--json"], env).stdout);
  const paired = await (await fetch(`${url}/api/v1/pair`, { method: "POST", headers: { "content-type": "application/json", "x-jarvis-client": "1" }, body: JSON.stringify({ code, kind: "cli", clientName: "child-test" }) })).json();
  const headers = { authorization: `Bearer ${paired.token}`, "content-type": "application/json", "x-jarvis-client": "1" };
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${url}/api/v1${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const parsed = await res.json();
    if (res.status >= 400) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(parsed)}`);
    return parsed;
  };
  if (!(await api("GET", "/config")).config.setupCompleted) {
    await api("POST", "/setup/data-folder", { path: join(stateDir, "..", "data") });
    await api("POST", "/setup/complete");
  }
  return {
    stateDir,
    api,
    log: () => {
      const f = join(stateDir, "logs/service.log");
      return existsSync(f) ? readFileSync(f, "utf8") : "";
    },
    async stop() {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    },
  };
}

export interface ReviewRequest {
  number: number;
  title: string;
  author?: string;
}

/**
 * How long ago the stand-in's review requests were made: ten and a half days, so Jarvis says "10 days ago".
 * Half a day away from a whole number of days, because Jarvis reads its clock after the stand-in did, and a
 * request exactly ten days old reads as 9 days whenever the system clock is set back a little in between
 * (Windows Time corrects a virtual machine's clock that way).
 */
const REVIEW_REQUEST_AGE_MS = 10.5 * 86_400_000;

/**
 * A GitHub stand-in that accepts only `token` and asks for a review, ten days
 * old and so urgent, of each pull request `prs()` lists at the time.
 */
export async function githubAskingForReviews(token: string, prs: () => ReviewRequest[]): Promise<FixtureServer> {
  const fx = await startFixtureServer();
  const authed = (h: Record<string, unknown>) => String(h.authorization ?? "").includes(token);
  fx.route("GET", "/user", (req) => (authed(req.headers) ? { json: { login: "owner" }, headers: { "x-oauth-scopes": "repo" } } : { status: 401, json: { message: "Bad credentials" } }));
  fx.route("GET", "/search/issues", (req) => {
    if (!authed(req.headers)) return { status: 401, json: { message: "Bad credentials" } };
    const items = req.query.get("q")!.includes("review-requested:@me")
      ? prs().map((p) => ({ number: p.number, title: p.title, html_url: `https://github.com/a/b/pull/${p.number}`, state: "open", draft: false, user: { login: p.author ?? "ada" }, repository_url: "https://api.github.com/repos/a/b", created_at: new Date(Date.now() - REVIEW_REQUEST_AGE_MS).toISOString(), updated_at: new Date().toISOString() }))
      : [];
    return { json: { incomplete_results: false, items } };
  });
  fx.route("GET", /\/pulls\/\d+$/, () => ({ json: { head: { sha: "abc" } } }));
  return fx;
}

/** Connect GitHub with `token`, against the stand-in. */
export const connectGithub = (svc: ChildService, fx: FixtureServer, token: string) => svc.api("POST", "/connections/github/configure", { method: "token", fields: { token, apiBaseUrl: fx.url } });

/** Refresh GitHub and wait for the job to end; returns its final status. */
export async function syncGithub(svc: ChildService): Promise<string> {
  const { job } = await svc.api("POST", "/connections/github/refresh");
  for (let i = 0; i < 300; i++) {
    const r = await svc.api("GET", `/jobs/${job.id}`);
    if (["succeeded", "failed", "blocked", "cancelled"].includes(r.job.status)) return r.job.status;
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error("sync did not finish");
}
