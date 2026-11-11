import { expect } from "vitest";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import type { TestMachine } from "./machines.ts";

export const CHECK = 60_000;
export const AFTER_WRITE = 30_000;
/** The silence after which a standby Machine may take the Reader's place. */
export const SILENCE = 30 * 60_000;
/** A moment at which every enabled schedule on `m` is due, however often it already ran. */
function whenAllDue(m: TestMachine): Date {
  const next = m.app.scheduler
    .list()
    .flatMap((s) => (s.enabled && s.nextRunAt ? [Date.parse(s.nextRunAt)] : []))
    .concat(Date.now());
  return new Date(Math.max(...next) + 1);
}

export interface ReaderView {
  machine: { id: string; name: string } | null;
  thisMachine: boolean;
  replicated: boolean;
  heartbeatAt: string | null;
  silent: boolean;
  lastRefreshAt: string | null;
}

export const readerOn = (m: TestMachine) => m.get<ReaderView>("/reader");
export const idOf = async (m: TestMachine) => ((await m.get("/machine")) as { id: string }).id;

/** Every schedule falls due on `m`: what its scheduler did with each. */
export const tickAllDue = (m: TestMachine) => m.app.scheduler.tick(whenAllDue(m));

/** Every schedule falls due on `m`; returns the ids of the schedules that started a job. */
export function runSchedules(m: TestMachine): string[] {
  return tickAllDue(m)
    .filter((r) => r.jobId !== null)
    .map((r) => r.id);
}

/** Every schedule falls due on `m`; returns the jobs it started. */
export function startSchedules(m: TestMachine): string[] {
  return tickAllDue(m)
    .map((r) => r.jobId)
    .filter((id): id is string => id !== null);
}

/** Waits until `m` runs no job, e.g. the first Source refresh that finishing setup starts. */
export async function waitUntilIdle(m: TestMachine) {
  for (;;) {
    const jobs = (await m.get("/jobs")) as Array<{ id: string; status: string }>;
    const busy = jobs.find((j) => j.status === "queued" || j.status === "running");
    if (!busy) return;
    await m.waitJob(busy.id);
  }
}

/** Waits for the jobs to succeed; returns when each finished. */
export async function waitForJobs(m: TestMachine, ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    const { job } = await m.waitJob(id);
    expect(job.status).toBe("succeeded");
    out.push(job.finishedAt);
  }
  return out;
}

/** Runs `m`'s clock, and its checks, until it reads `at` (ms since the epoch). */
export async function advanceTo(m: TestMachine, at: number) {
  await m.clock.advance(Math.max(0, at - m.clock.now().getTime()));
}

/** A GitHub that answers like the real one for one open pull request awaiting review. */
export async function startGitHub(): Promise<FixtureServer> {
  const fx = await startFixtureServer();
  const at = new Date().toISOString();
  fx.route("GET", "/user", () => ({ json: { login: "owner" } }));
  fx.route("GET", "/search/issues", () => ({
    json: { incomplete_results: false, items: [{ number: 7, title: "Tidy the release notes", html_url: "https://github.com/acme/site/pull/7", state: "open", draft: false, user: { login: "kai" }, repository_url: "https://api.github.com/repos/acme/site", created_at: at, updated_at: at }] },
  }));
  fx.route("GET", /pulls\/7$/, () => ({ json: { head: { sha: "abc" } } }));
  return fx;
}

/** Connects GitHub as a source on `m`, the way the owner does in the Dashboard. */
export async function connectGitHub(m: TestMachine, github: FixtureServer) {
  const r = await m.post("/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678", apiBaseUrl: github.url } });
  expect(r.test).toMatchObject({ ok: true });
}
