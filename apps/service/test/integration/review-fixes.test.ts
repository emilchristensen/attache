/** Regression tests for defects found in the independent review (each reproduces the reported failure). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer, type FixtureServer } from "../fixtures/fixture-server.ts";
import { JobQueue } from "../../src/jobs/queue.ts";
import { openDb } from "../../src/core/db.ts";
import { createLogger } from "../../src/core/log.ts";
import { CoverageTracker } from "../../src/connectors/types.ts";

let svc: TestService;
let fx: FixtureServer;
const posted: Array<{ id: number; body: string }> = [];
let readBackStatus = 200;
let searchDelayMs = 0;

beforeAll(async () => {
  fx = await startFixtureServer();
  fx.route("GET", "/user", () => ({ json: { login: "t" } }));
  fx.route("GET", "/search/issues", async () => {
    if (searchDelayMs) await new Promise((r) => setTimeout(r, searchDelayMs));
    return { json: { incomplete_results: false, items: [{ number: 5, title: "Leaked ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 token", html_url: "https://github.com/a/b/pull/5", state: "open", draft: false, user: { login: "x" }, repository_url: "https://api.github.com/repos/a/b", created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] } };
  });
  fx.route("GET", /pulls\/5$/, () => ({ json: { head: { sha: "s" } } }));
  fx.route("POST", "/repos/a/b/issues/5/comments", (req) => {
    const c = { id: 700 + posted.length, body: (req.body as { body: string }).body, html_url: "https://github.com/a/b/pull/5#c" };
    posted.push(c);
    return { status: 201, json: c };
  });
  fx.route("GET", /^\/repos\/a\/b\/issues\/comments\/\d+$/, () => (readBackStatus === 200 ? { json: posted.at(-1) } : { status: readBackStatus, json: { message: "bad gateway" } }));
  fx.route("GET", "/repos/a/b/issues/5/comments", () => ({ json: posted }));
  svc = await startTestService();
  await svc.post("/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678", apiBaseUrl: fx.url } });
  await svc.put("/connections/github/write-actions", { writeActions: ["github.comment"], confirm: true });
});
afterAll(async () => {
  await svc.stop();
  await fx.close();
});

const draft = () => svc.app.actions.createDraft({ kind: "github.comment", connectionId: "github", title: "t", target: { repo: "a/b", number: 5 }, payload: { body: `hello ${Math.random()}` }, context: {}, createdBy: "test" });
async function approveAndExecute(id: string) {
  const a = svc.app.actions.get(id)!;
  const ap = await svc.post(`/actions/${id}/approve`, { version: a.version, payloadHash: a.payloadHash });
  const r = await svc.call("POST", `/actions/${id}/execute`, { nonce: ap.approval.nonce, version: ap.version, payloadHash: ap.payloadHash });
  return r;
}

describe("review fixes", () => {
  it("#1 a write whose read-back fails is 'unknown', not 'failed', and is not re-sent", async () => {
    readBackStatus = 502;
    const d = draft();
    const r = await approveAndExecute(d.id);
    await svc.waitJob(r.body.job.id);
    const a = await svc.get(`/actions/${d.id}`);
    expect(a.status).toBe("unknown");
    expect(a.receipt.note).toMatch(/could not be read back|Check the target/);
    expect(posted).toHaveLength(1);
    readBackStatus = 200;
  });

  it("#2 a cancelled send never leaves the action executing, and action jobs cannot be retried", async () => {
    svc.app.jobs.stop();
    const d = draft();
    const r = await approveAndExecute(d.id);
    await svc.post(`/jobs/${r.body.job.id}/cancel`);
    expect((await svc.get(`/actions/${d.id}`)).status).toBe("failed");
    const retry = await svc.call("POST", `/jobs/${r.body.job.id}/retry`);
    expect(retry.status).toBe(409);
    expect(retry.body.error.message).toMatch(/Approve the draft again/);
    svc.app.jobs.start();
  });

  it("#2 an execution that starts after the approval expired is refused before any request", async () => {
    svc.app.jobs.stop();
    const d = draft();
    const r = await approveAndExecute(d.id);
    svc.app.db.prepare("update actions set approval = json_set(approval, '$.expiresAt', ?) where id = ?").run(new Date(Date.now() - 1000).toISOString(), d.id);
    const before = posted.length;
    svc.app.jobs.start();
    await svc.waitJob(r.body.job.id);
    const a = await svc.get(`/actions/${d.id}`);
    expect(a).toMatchObject({ status: "failed", receipt: { attempted: false } });
    expect(a.receipt.error).toMatch(/approval expired/i);
    expect(posted.length).toBe(before);
  });

  it("#3 a cancel requested before a restart is honoured after it", async () => {
    const db = openDb(":memory:");
    const q1 = new JobQueue(db, createLogger(null, { quiet: true }));
    const job = q1.create({ kind: "demo-long", title: "x", input: {} }).job;
    db.prepare("update jobs set status = 'running', lease_owner = 'dead-process', cancel_requested_at = ? where id = ?").run(new Date().toISOString(), job.id);
    let ran = 0;
    const q2 = new JobQueue(db, createLogger(null, { quiet: true }));
    q2.register("demo-long", async () => ++ran);
    q2.start();
    await new Promise((r) => setTimeout(r, 100));
    await q2.stop();
    expect(q2.get(job.id)).toMatchObject({ status: "cancelled", cancelOutcome: "stopped" });
    expect(ran).toBe(0);
  });

  it("#4 a cancel that arrives after the work finished reports too_late, not stopped", async () => {
    const db = openDb(":memory:");
    const q = new JobQueue(db, createLogger(null, { quiet: true }));
    let release!: () => void;
    q.register("demo-long", () => new Promise((res) => (release = () => res("done"))));
    const job = q.create({ kind: "demo-long", title: "x", input: {} }).job;
    q.start();
    await new Promise((r) => setTimeout(r, 50));
    q.cancel(job.id);
    release();
    await new Promise((r) => setTimeout(r, 50));
    await q.stop();
    expect(q.get(job.id)).toMatchObject({ status: "succeeded", cancelOutcome: "too_late" });
  });

  it("#5 disconnecting during a sync stops it from storing data or reviving the connection", async () => {
    searchDelayMs = 400;
    const sync = await svc.post("/connections/github/refresh");
    await new Promise((r) => setTimeout(r, 100));
    await svc.post("/connections/github/disconnect", { deleteData: true });
    await svc.waitJob(sync.job.id).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
    searchDelayMs = 0;
    expect((await svc.get("/connections")).find((c: any) => c.kind === "github").status).toBe("not_configured");
    expect(svc.app.db.prepare("select count(*) n from observations where connection_id = 'github'").get()).toMatchObject({ n: 0 });
    expect(svc.app.db.prepare("select count(*) n from attention_items where connection_id = 'github'").get()).toMatchObject({ n: 0 });
  });

  it("#7 secrets in source data are redacted from archived evidence", async () => {
    await svc.post("/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678", apiBaseUrl: fx.url } });
    const s = await svc.post("/connections/github/refresh");
    await svc.waitJob(s.job.id);
    const dir = join(svc.dataDir, "evidence/connectors/github");
    const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
    expect(text).toContain("Leaked [REDACTED] token");
    expect(text).not.toContain("ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
  });

  it("#8 revoking a client closes its open event stream", async () => {
    const { createPairingCode, redeemPairingCode } = await import("../../src/http/security.ts");
    const { code } = createPairingCode(svc.app.db);
    const other = redeemPairingCode(svc.app.db, code, { name: "other", kind: "cli" })!;
    const res = await fetch(`${svc.url}/api/v1/events`, { headers: { authorization: `Bearer ${other.token}` } });
    const reader = res.body!.getReader();
    await reader.read();
    await svc.call("DELETE", `/clients/${other.client.id}`);
    const end = await Promise.race([reader.read().then((r) => r.done), new Promise((r) => setTimeout(() => r("timeout"), 2000))]);
    expect(end).toBe(true);
    expect((await fetch(`${svc.url}/api/v1/status`, { headers: { authorization: `Bearer ${other.token}` } })).status).toBe(401);
  });

  it("#11 a fresh event stream starts at now; a reconnect replays every missed event beyond one batch", async () => {
    const job = svc.app.jobs.create({ kind: "demo-long", title: "events", input: { steps: 1, stepMs: 1 } }).job;
    // Let the job finish first: its own live events would otherwise reach the fresh stream.
    await svc.waitJob(job.id);
    const start = Number((svc.app.db.prepare("select max(seq) m from job_events").get() as { m: number }).m);
    const ins = svc.app.db.prepare("insert into job_events (job_id, type, data, at) values (?, 'progress', '{}', ?)");
    for (let i = 0; i < 1500; i++) ins.run(job.id, new Date().toISOString());
    const read = async (headers: Record<string, string>) => {
      const ctrl = new AbortController();
      const res = await fetch(`${svc.url}/api/v1/events`, { headers: { authorization: `Bearer ${svc.token}`, ...headers }, signal: ctrl.signal });
      const reader = res.body!.getReader();
      let text = "";
      const t = setTimeout(() => ctrl.abort(), 700);
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          text += new TextDecoder().decode(value);
        }
      } catch {
        // aborted
      }
      clearTimeout(t);
      return [...text.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    };
    expect(await read({})).toEqual([]);
    const replayed = await read({ "last-event-id": String(start) });
    expect(replayed.length).toBeGreaterThanOrEqual(1500);
    expect(replayed[0]).toBe(start + 1);
  });

  it("#13 opt-in scopes with nothing configured do not make a source permanently partial", () => {
    const c = new CoverageTracker();
    c.add("DMs", "complete", 2, 1);
    c.add("Channels", "not_configured", 0, 0, "No channels listed");
    expect(c.finish().state).toBe("complete");
  });

  it("minor: a disconnected connection is not revived by a test; bad limits do not break queries", async () => {
    await svc.post("/connections/github/disconnect", { deleteData: false });
    const t = await svc.post("/connections/github/test");
    expect(t.test.ok).toBe(false);
    expect(t.status.status).toBe("disconnected");
    expect((await svc.call("GET", "/jobs?limit=abc")).status).toBe(200);
    expect((await svc.call("GET", "/memory/changes?limit=-5")).status).toBe(200);
  });

  it("connections from the old transports lose their stale credentials once and ask to be set up again", async () => {
    const app = svc.app;
    const ins = app.db.prepare("insert into connections (id, kind, label, status, settings, read_scopes, write_actions, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)");
    const now = new Date().toISOString();
    ins.run("slack", "slack", "Slack", "connected", JSON.stringify({ authMethod: "token", channels: "C0123" }), '["dms"]', '["slack.post"]', now, now);
    ins.run("confluence", "confluence", "Confluence", "connected", JSON.stringify({ authMethod: "api-token", siteUrl: "https://acme.atlassian.net", email: "e@x.com" }), '["mentions"]', "[]", now, now);
    ins.run("gcal", "gcal", "Google Calendar", "connected", JSON.stringify({ authMethod: "claude-ai" }), '["upcoming"]', "[]", now, now);
    await app.secrets.set("conn:slack:token", "xoxp-legacy-token-value");
    await app.secrets.set("conn:confluence:apiToken", "ATATT-legacy");
    expect(await app.connections.migrateLegacyTransports()).toEqual(["slack", "confluence"]);
    expect(await app.secrets.get("conn:slack:token")).toBeNull();
    expect(await app.secrets.get("conn:confluence:apiToken")).toBeNull();
    const slack = app.connections.record("slack")!;
    expect(slack).toMatchObject({ status: "needs_auth", readScopes: ["dms"], writeActions: ["slack.post"] });
    expect(slack.settings.channels).toBe("C0123");
    expect(app.connections.status(slack).lastError).toMatch(/claude\.ai connector/);
    expect(app.connections.record("gcal")!.status).toBe("connected");
    // Idempotent: a second start changes nothing.
    expect(await app.connections.migrateLegacyTransports()).toEqual([]);
    for (const id of ["slack", "confluence", "gcal"]) app.db.prepare("delete from connections where id = ?").run(id);
  });
});
