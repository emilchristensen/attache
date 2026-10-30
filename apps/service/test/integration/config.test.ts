import { afterAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { startTestService, type TestService } from "./harness.ts";
import { startFixtureServer } from "../fixtures/fixture-server.ts";
import { createPairingCode } from "../../src/http/security.ts";

const running: TestService[] = [];
afterAll(async () => {
  for (const s of running) await s.stop().catch(() => {});
});

describe("A03 onboarding and persistence", () => {
  it("notes-only onboarding completes and every selection persists across restart", async () => {
    const svc = await startTestService({ setup: false });
    // Dependency failures are explained and recoverable.
    const dep = await svc.call("PUT", "/features", { changes: { drafts: true, attention: false } });
    expect(dep.status).toBe(409);
    expect(dep.body.error.code).toBe("dependency");
    expect(dep.body.error.message).toMatch(/Drafts and approvals needs Attention and briefings/);
    const preview = await svc.post("/setup/data-folder/preview", { path: svc.dataDir });
    expect(preview).toMatchObject({ exists: false, writable: true, willModify: [] });
    const early = await svc.call("POST", "/setup/complete");
    expect(early.body.error.code).toBe("needs_data_folder");
    await svc.post("/setup/data-folder", { path: svc.dataDir });
    await svc.put("/features", { changes: { voice: true, drafts: false }, cascade: true });
    await svc.call("PATCH", "/config", { schedules: { syncEveryMinutes: 45, briefingAt: "07:30" }, notifications: { desktop: true } });
    const done = await svc.post("/setup/complete");
    expect(done.config.setupCompleted).toBe(true);
    const statuses = Object.fromEntries(done.features.map((f: any) => [f.id, f.readiness]));
    expect(statuses).toMatchObject({ recall: "ready", conversation: "partial", capture: "ready", attention: "ready", drafts: "disabled", voice: "needs_setup" });
    const stateDir = svc.stateDir;
    const dataDir = svc.dataDir;
    await svc.stop();
    const again = await startTestService({ stateDir, dataDir, setup: false });
    running.push(again);
    const cfg = await again.get("/config");
    expect(cfg.config).toMatchObject({ setupCompleted: true, dataFolder: dataDir, schedules: { syncEveryMinutes: 45, briefingAt: "07:30" }, notifications: { desktop: true } });
    expect(cfg.features).toMatchObject({ voice: true, drafts: false, attention: true });
    // Search works before any model is connected.
    await again.post("/memory/capture", { text: "The espresso machine needs descaling every Friday.", source: { kind: "user", ref: "t" } });
    expect((await again.get("/memory/search?q=espresso descaling")).hits.length).toBeGreaterThan(0);
  });
});

describe("A04 configuration drives backend behaviour", () => {
  it("disable/re-enable changes schedules, endpoints and queued work; disconnect honours retention", async () => {
    const fx = await startFixtureServer();
    fx.route("GET", "/user", () => ({ json: { login: "t" } }));
    fx.route("GET", "/search/issues", () => ({ json: { incomplete_results: false, items: [{ number: 1, title: "PR", html_url: "https://github.com/a/b/pull/1", state: "open", draft: false, user: { login: "x" }, repository_url: "https://api.github.com/repos/a/b", created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] } }));
    fx.route("GET", /pulls\/1$/, () => ({ json: { head: { sha: "s" } } }));
    const svc = await startTestService();
    running.push(svc);
    await svc.post("/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678", apiBaseUrl: fx.url } });
    const s1 = await svc.get("/schedules");
    expect(s1.filter((s: any) => s.capability === "attention").every((s: any) => s.enabled)).toBe(true);
    // Queue work, then disable attention: triggers stop, queued jobs are cancelled, endpoints refuse.
    svc.app.jobs.stop();
    const queued = svc.app.jobs.create({ kind: "sync", title: "q", input: { all: true }, capability: "attention" }).job;
    const off = await svc.put("/features", { changes: { attention: false }, cascade: true });
    expect(off.removed).toEqual(["drafts"]);
    expect(off.effects.cancelledJobs).toContain(queued.id);
    expect((await svc.get(`/jobs/${queued.id}`)).job).toMatchObject({ status: "cancelled", cancelOutcome: "not_started" });
    const s2 = await svc.get("/schedules");
    expect(s2.filter((s: any) => s.capability === "attention").every((s: any) => !s.enabled && s.nextRunAt === null)).toBe(true);
    expect((await svc.call("GET", "/attention")).body.error.code).toBe("feature_disabled");
    expect((await svc.call("POST", "/connections/github/sync")).body.error.code).toBe("feature_disabled");
    // Scheduler tick enqueues nothing for a disabled capability.
    expect(svc.app.scheduler.tick(new Date(Date.now() + 86_400_000))).toEqual([]);
    const on = await svc.put("/features", { changes: { attention: true, drafts: true }, cascade: true });
    expect(on.effects.enabled).toEqual(expect.arrayContaining(["attention", "drafts"]));
    const s3 = await svc.get("/schedules");
    expect(s3.filter((s: any) => s.capability === "attention").every((s: any) => s.enabled && s.nextRunAt)).toBe(true);
    svc.app.jobs.start();
    const sync = await svc.post("/connections/github/sync");
    await svc.waitJob(sync.job.id);
    // The fixture answers both default scopes (review requests, authored PRs), so there is one observation per scope.
    const observed = Number((svc.app.db.prepare("select count(*) n from observations where connection_id = 'github'").get() as { n: number }).n);
    expect(observed).toBe(2);
    // Disconnect, keeping data: credentials gone, requests stop, data kept but items closed.
    const preview = await svc.get("/connections/github/disconnect-preview");
    expect(preview).toMatchObject({ observations: observed, attentionItems: 1, credentials: 1 });
    const before = fx.requests.length;
    const kept = await svc.post("/connections/github/disconnect", { deleteData: false });
    expect(kept.deleted).toBe(false);
    expect(await svc.app.secrets.get("conn:github:token")).toBeNull();
    expect(svc.app.db.prepare("select count(*) n from observations where connection_id = 'github'").get()).toMatchObject({ n: observed });
    expect((await svc.call("POST", "/connections/github/sync")).body.error.code).toBe("disconnected");
    await svc.post("/jobs", { kind: "sync", input: { connectionId: "github" } }).then((r) => svc.waitJob(r.job.id));
    expect(fx.requests.length).toBe(before);
    // Reconnect then disconnect deleting data.
    await svc.post("/connections/github/configure", { method: "token", fields: { token: "ghp_fixturetokenfixturetoken12345678", apiBaseUrl: fx.url } });
    await svc.post("/connections/github/disconnect", { deleteData: true });
    expect(svc.app.db.prepare("select count(*) n from observations where connection_id = 'github'").get()).toMatchObject({ n: 0 });
    expect((await svc.get("/connections")).find((c: any) => c.kind === "github").status).toBe("not_configured");
    await fx.close();
  });

  it("disconnecting an imported folder can delete its index without touching the folder", async () => {
    const svc = await startTestService();
    running.push(svc);
    const vault = join(svc.dataDir, "..", "vault");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, "Zephyr.md"), "# Zephyr\n\nZephyr budget owner is Kai.\n");
    const imp = await svc.post("/import", { path: vault });
    await svc.waitJob(imp.job.id);
    expect((await svc.get("/memory/search?q=zephyr budget")).hits[0].root).toBe(`import:${imp.connection.id}`);
    await svc.post(`/connections/${imp.connection.id}/disconnect`, { deleteData: true });
    expect((await svc.get("/memory/search?q=zephyr budget")).hits).toHaveLength(0);
    expect(readFileSync(join(vault, "Zephyr.md"), "utf8")).toContain("Kai");
    expect(readdirSync(vault)).toEqual(["Zephyr.md"]);
  });
});

describe("A13 security boundaries", () => {
  it("binds loopback, checks Host and Origin, requires pairing and the CSRF header", async () => {
    const svc = await startTestService();
    running.push(svc);
    const port = new URL(svc.url).port;
    const raw = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(`${svc.url}/api/v1${path}`, init);
    expect((await raw("/health")).status).toBe(200);
    expect((await raw("/status")).status).toBe(401);
    expect((await raw("/status", { headers: { authorization: "Bearer not-a-real-token-xxxxxxxxxxxxxxxx" } })).status).toBe(401);
    expect((await raw("/health", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    // The Obsidian plugin is gone, so its app origin is refused like any other.
    expect((await raw("/health", { headers: { origin: "app://obsidian.md" } })).status).toBe(403);
    const noCsrf = await raw("/memory/capture", { method: "POST", headers: { authorization: `Bearer ${svc.token}`, "content-type": "application/json" }, body: JSON.stringify({ text: "x", source: { kind: "user", ref: "x" } }) });
    expect(noCsrf.status).toBe(403);
    // Host header rebinding (raw HTTP so the header is not normalised).
    const http = await import("node:http");
    const status = await new Promise<number>((resolve) => http.get({ host: "127.0.0.1", port, path: "/api/v1/health", headers: { host: `attacker.example:${port}` } }, (r) => resolve(r.statusCode!)));
    expect(status).toBe(421);
    // Pairing codes are single use.
    const { code } = createPairingCode(svc.app.db);
    const pair = (c: string) => raw("/pair", { method: "POST", headers: { "content-type": "application/json", "x-jarvis-client": "1" }, body: JSON.stringify({ code: c, kind: "cli", clientName: "script" }) });
    expect((await pair(code)).status).toBe(200);
    expect((await pair(code)).status).toBe(401);
    // Path traversal is refused.
    const trav = await svc.call("GET", `/memory/document?root=data&path=${encodeURIComponent("../../etc/passwd")}`);
    expect(trav.status).toBe(400);
    // Protected identity cannot be written through memory endpoints.
    await svc.post("/setup/identity", { name: "Test User", email: "t@example.com", confirm: true });
    const prot = await svc.call("POST", "/memory/correct", { relPath: "memory/self.md", subject: "Name", value: "Mallory", reason: "x" });
    expect(prot.status).toBe(403);
    expect(readFileSync(join(svc.dataDir, "memory/self.md"), "utf8")).not.toContain("Mallory");
  });

  it("secrets never appear in API responses, logs, the database or the data folder", async () => {
    const svc = await startTestService();
    running.push(svc);
    const secret = "ghp_SuperSecretValue1234567890abcdefXYZ";
    const fx = await startFixtureServer();
    fx.route("GET", "/user", () => ({ status: 401, json: { message: `Bad credentials for ${secret}` } }));
    await svc.post("/connections/github/configure", { method: "token", fields: { token: secret, apiBaseUrl: fx.url } });
    const everything = JSON.stringify([await svc.get("/connections"), await svc.get("/capabilities"), await svc.get("/status")]);
    expect(everything).not.toContain(secret);
    const log = existsSync(join(svc.stateDir, "logs/service.log")) ? readFileSync(join(svc.stateDir, "logs/service.log"), "utf8") : "";
    expect(log).not.toContain(secret);
    const dbDump = JSON.stringify(svc.app.db.prepare("select * from connections").all()) + JSON.stringify(svc.app.db.prepare("select * from audit").all());
    expect(dbDump).not.toContain(secret);
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of walk(svc.dataDir)) expect(readFileSync(f, "utf8")).not.toContain(secret);
    await fx.close();
  });
});
