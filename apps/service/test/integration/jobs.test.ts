import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { JobQueue, JobBlockedError } from "../../src/jobs/queue.ts";
import { openDb } from "../../src/core/db.ts";
import { createLogger } from "../../src/core/log.ts";

const ROOT = resolve(import.meta.dirname, "../../../..");
const BUNDLE = join(ROOT, "apps/service/dist/jarvis-service.mjs");

let svc: TestService;
beforeAll(async () => {
  svc = await startTestService();
});
afterAll(() => svc.stop());

describe("A08 durable jobs", () => {
  it("retry reports the actual outcome of each attempt", async () => {
    const { job } = await svc.post("/jobs", { kind: "demo-long", input: { steps: 2, stepMs: 10, failUntilAttempt: 1, maxAttempts: 3 } });
    const done = await svc.waitJob(job.id, ["succeeded", "failed"], 20_000);
    expect(done.job.status).toBe("succeeded");
    expect(done.job.attempts).toBe(2);
    const types = done.events.map((e: any) => e.type);
    expect(types).toContain("retry_scheduled");
    expect(done.events.find((e: any) => e.type === "retry_scheduled").data.error).toMatch(/Simulated failure on attempt 1/);
    const failing = (await svc.post("/jobs", { kind: "demo-long", input: { steps: 1, stepMs: 5, failUntilAttempt: 9, maxAttempts: 1 } })).job;
    const f = await svc.waitJob(failing.id);
    expect(f.job.status).toBe("failed");
    expect(f.job.error).toMatch(/Simulated failure/);
    const retried = await svc.post(`/jobs/${failing.id}/retry`);
    expect(retried.job.status).toBe("queued");
    const f2 = await svc.waitJob(failing.id);
    expect(f2.job.status).toBe("failed");
    expect(f2.job.attempts).toBe(2);
  });

  it("cancellation says whether it stopped work or arrived after completion", async () => {
    const { job } = await svc.post("/jobs", { kind: "demo-long", input: { steps: 50, stepMs: 100 } });
    await svc.waitJob(job.id, ["running"]);
    const c = await svc.post(`/jobs/${job.id}/cancel`);
    expect(c.outcome).toBe("pending");
    const done = await svc.waitJob(job.id);
    expect(done.job.status).toBe("cancelled");
    expect(done.job.cancelOutcome).toBe("stopped");
    expect(done.job.progress).toBeLessThan(1);
    const quick = (await svc.post("/jobs", { kind: "demo-long", input: { steps: 1, stepMs: 5 } })).job;
    await svc.waitJob(quick.id);
    const late = await svc.post(`/jobs/${quick.id}/cancel`);
    expect(late.outcome).toBe("too_late");
    expect((await svc.get(`/jobs/${quick.id}`)).job).toMatchObject({ status: "succeeded", cancelOutcome: "too_late" });
  });

  it("a job persists before acknowledgement and duplicates are idempotent", async () => {
    const a = await svc.call("POST", "/jobs", { kind: "demo-long", input: { steps: 1, stepMs: 5 }, idempotencyKey: "once" });
    const b = await svc.call("POST", "/jobs", { kind: "demo-long", input: { steps: 1, stepMs: 5 }, idempotencyKey: "once" });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.job.id).toBe(a.body.job.id);
    expect(svc.app.db.prepare("select count(*) n from jobs where idempotency_key = 'once'").get()).toMatchObject({ n: 1 });
  });

  it("reconnecting clients receive every missed event in order (Last-Event-ID)", async () => {
    const { job } = await svc.post("/jobs", { kind: "demo-long", input: { steps: 12, stepMs: 60 } });
    const read = async (lastId: number | null, ms: number) => {
      const ctrl = new AbortController();
      const res = await fetch(`${svc.url}/api/v1/events`, { headers: { authorization: `Bearer ${svc.token}`, ...(lastId ? { "last-event-id": String(lastId) } : {}) }, signal: ctrl.signal });
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const events: Array<{ id: number; ev: any }> = [];
      const t = setTimeout(() => ctrl.abort(), ms);
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value);
          let i: number;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const id = /^id: (\d+)$/m.exec(frame)?.[1];
            const data = /^data: (.*)$/m.exec(frame)?.[1];
            if (id && data) events.push({ id: Number(id), ev: JSON.parse(data) });
          }
        }
      } catch {
        // aborted
      } finally {
        clearTimeout(t);
      }
      return events.filter((e) => e.ev.event?.jobId === job.id || !e.ev.event);
    };
    const first = await read(null, 250);
    expect(first.length).toBeGreaterThan(0);
    const lastSeen = first.at(-1)!.id;
    await new Promise((r) => setTimeout(r, 400)); // "tab closed" while the job keeps running
    await svc.waitJob(job.id);
    const second = await read(lastSeen, 300);
    const jobEvents = second.filter((e) => e.ev.event?.jobId === job.id);
    expect(jobEvents[0]!.id).toBeGreaterThan(lastSeen);
    const all = svc.app.jobs.eventsSince(lastSeen).filter((e) => e.jobId === job.id).map((e) => e.seq);
    expect(jobEvents.map((e) => e.id)).toEqual(all);
    expect(jobEvents.at(-1)!.ev.event.type).toBe("succeeded");
    for (let i = 1; i < jobEvents.length; i++) expect(jobEvents[i]!.id).toBeGreaterThan(jobEvents[i - 1]!.id);
  });

  it("disabling a capability cancels its queued work and blocks new work", async () => {
    await svc.put("/features", { changes: { jobs: false }, cascade: true });
    const r = await svc.call("POST", "/jobs", { kind: "research", input: { question: "x" } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("feature_disabled");
    await svc.put("/features", { changes: { jobs: true, attention: true, drafts: true }, cascade: true });
  });
});

describe("outbox: side effects run at most once across recovery", () => {
  it("a pending effect with a lookup is recovered instead of repeated; without a lookup the job blocks", async () => {
    const db = openDb(":memory:");
    const q = new JobQueue(db, createLogger(null, { quiet: true }));
    let calls = 0;
    q.register("action", async (ctx) => ctx.effect("eff-1", async () => ++calls, async () => 42));
    q.register("demo-long", async (ctx) => ctx.effect("eff-2", async () => ++calls));
    db.prepare("insert into side_effects (effect_key, status, created_at) values ('eff-1','pending','x'), ('eff-2','pending','x')").run();
    const a = q.create({ kind: "action", title: "a", input: {} }).job;
    const b = q.create({ kind: "demo-long", title: "b", input: {} }).job;
    q.start();
    for (let i = 0; i < 100 && ["queued", "running"].some((s) => [q.get(a.id)!.status, q.get(b.id)!.status].includes(s as never)); i++) await new Promise((r) => setTimeout(r, 20));
    await q.stop();
    expect(q.get(a.id)).toMatchObject({ status: "succeeded", result: 42 });
    expect(q.get(b.id)!.status).toBe("blocked");
    expect(q.get(b.id)!.error).toMatch(/will not be repeated/);
    expect(calls).toBe(0);
    expect(JobBlockedError).toBeTruthy();
  });
});

describe("A08 service restart recovers work without duplicate execution", () => {
  let child: ChildProcess | null = null;
  const stateDir = mkdtempSync(join(tmpdir(), "jarvis-restart-state-"));
  const dataDir = join(mkdtempSync(join(tmpdir(), "jarvis-restart-data-")), "d");
  const env = { ...process.env, JARVIS_CREDENTIAL_STORE: "file", JARVIS_NO_NOTIFY: "1", JARVIS_INSTANCE: "restart-test" };

  const boot = async (): Promise<string> => {
    child = spawn(process.execPath, [BUNDLE, "serve", "--state-dir", stateDir, "--port", "0"], { env, stdio: "ignore" });
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const rt = join(stateDir, "runtime.json");
      if (existsSync(rt)) {
        const j = JSON.parse(readFileSync(rt, "utf8"));
        if (j.pid === child.pid) return j.url;
      }
    }
    throw new Error("service did not start");
  };
  afterAll(() => {
    child?.kill("SIGKILL");
  });

  it("kill -9 mid-job, restart, job resumes from its checkpoint and its effect is not repeated", async () => {
    execFileSync(process.execPath, [join(ROOT, "apps/service/build.mjs")], { stdio: "ignore" });
    let url = await boot();
    const code = JSON.parse(execFileSync(process.execPath, [BUNDLE, "pair", "--state-dir", stateDir, "--json"], { env }).toString()).code;
    const paired = await (await fetch(`${url}/api/v1/pair`, { method: "POST", headers: { "content-type": "application/json", "x-jarvis-client": "1" }, body: JSON.stringify({ code, kind: "cli", clientName: "restart-test" }) })).json();
    const h = { authorization: `Bearer ${paired.token}`, "content-type": "application/json", "x-jarvis-client": "1" };
    const api = async (method: string, path: string, body?: unknown) => (await fetch(`${url}/api/v1${path}`, { method, headers: h, ...(body ? { body: JSON.stringify(body) } : {}) })).json();
    await api("POST", "/setup/data-folder", { path: dataDir });
    await api("POST", "/setup/complete");
    const { job } = await api("POST", "/jobs", { kind: "demo-long", input: { steps: 10, stepMs: 250, effectAtStep: 1 } });
    for (let i = 0; i < 100; i++) {
      const r = await api("GET", `/jobs/${job.id}`);
      if (r.job.progress >= 0.4) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    const before = await api("GET", `/jobs/${job.id}`);
    expect(before.job.status).toBe("running");
    const stepBefore = Math.round(before.job.progress * 10);
    child!.kill("SIGKILL");
    await new Promise((r) => child!.once("exit", r));
    url = await boot();
    let after: any;
    for (let i = 0; i < 200; i++) {
      after = await api("GET", `/jobs/${job.id}`);
      if (after.job.status === "succeeded") break;
      await new Promise((res) => setTimeout(res, 100));
    }
    expect(after.job.status).toBe("succeeded");
    const types = after.events.map((e: any) => e.type);
    expect(types).toContain("recovered");
    expect(types.filter((t: string) => t === "effect_done")).toHaveLength(1);
    // Progress resumed from the checkpoint rather than restarting at step 1.
    const recoveredAt = types.lastIndexOf("recovered");
    const firstProgressAfter = after.events.slice(recoveredAt).find((e: any) => e.type === "progress");
    expect(Math.round(firstProgressAfter.data.progress * 10)).toBeGreaterThan(stepBefore);
    // The external side effect (a deliverable file) exists exactly once.
    const files = readdirSync(join(dataDir, "deliverables/research")).filter((f) => f.includes(job.id.slice(0, 8)));
    expect(files).toHaveLength(1);
  }, 60_000);
});
