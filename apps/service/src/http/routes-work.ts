import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { ActionApproveInput, ActionEditInput, ActionExecuteInput, ConnectionKind, JobCreateInput, API_PREFIX, type JobKind } from "@jarvis/contracts";
import type { Router } from "./router.ts";
import { HttpError } from "./router.ts";
import type { App } from "../app.ts";
import { requireFeature } from "./routes-data.ts";
import { getItem } from "../attention/engine.ts";
import { FEATURES } from "../capabilities/registry.ts";
import { createBackup, listBackups } from "../backup.ts";
import { SpeechError } from "../speech/engine.ts";

/** Sign-ins in progress. Settings learned when starting (a newly registered client) are kept here and saved only when sign-in completes. */
const oauthPending = new Map<string, { kind: ConnectionKind; verifier: string; redirectUri: string; expires: number; settings: Record<string, unknown> }>();

function featureForJob(kind: JobKind) {
  return FEATURES.find((f) => f.jobKinds.includes(kind))?.id ?? "jobs";
}

export function registerWorkRoutes(r: Router, app: App, port: () => number) {
  // ---- jobs --------------------------------------------------------------------------
  r.get("/jobs", (c) => app.jobs.list({ ...(c.query("status") ? { status: c.query("status")!.split(",") } : {}), limit: Number(c.query("limit") ?? 100) }));
  r.post("/jobs", async (c) => {
    const input = await c.body(JobCreateInput);
    if (["action", "import"].includes(input.kind)) throw new HttpError(400, "invalid_request", `${input.kind} jobs are created by their own endpoints`);
    requireFeature(app, featureForJob(input.kind));
    if (input.kind === "research" && !String(input.input.question ?? "").trim()) throw new HttpError(400, "invalid_request", "A research job needs input.question");
    const { job, existing } = app.jobs.create({ kind: input.kind, title: input.title ?? defaultTitle(input.kind, input.input), input: input.input, idempotencyKey: input.idempotencyKey, capability: featureForJob(input.kind), connectionId: typeof input.input.connectionId === "string" ? input.input.connectionId : null, maxAttempts: input.kind === "demo-long" ? Number(input.input.maxAttempts ?? 3) : 3 });
    return { __status: existing ? 200 : 201, body: { job, existing } };
  });
  r.get("/jobs/:id", (c) => {
    const job = app.jobs.get(c.params.id!);
    if (!job) throw new HttpError(404, "not_found", "Job not found");
    return { job, events: app.jobs.eventsSince(Number(c.query("after") ?? 0), job.id) };
  });
  r.post("/jobs/:id/cancel", (c) => {
    const out = app.jobs.cancel(c.params.id!);
    return out;
  });
  r.post("/jobs/:id/retry", (c) => {
    try {
      return { job: app.jobs.retry(c.params.id!) };
    } catch (e) {
      throw new HttpError(409, "not_retryable", (e as Error).message);
    }
  });
  r.get("/schedules", () => app.scheduler.list());

  // ---- events (SSE) -------------------------------------------------------------------
  r.get("/events", (c) => {
    const res = c.res;
    const resume = c.req.headers["last-event-id"] ?? c.query("after");
    const maxSeq = Number((app.db.prepare("select coalesce(max(seq), 0) m from job_events").get() as { m: number }).m);
    // A fresh connection starts at "now"; a reconnect (Last-Event-ID) replays everything it missed.
    const after = resume !== undefined && resume !== null ? Number(resume) || 0 : maxSeq;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    const write = (ev: Record<string, unknown>, id?: number) => res.write(`${id !== undefined ? `id: ${id}\n` : ""}data: ${JSON.stringify(ev)}\n\n`);
    let lastSeq = after;
    for (;;) {
      const batch = app.jobs.eventsSince(lastSeq, undefined, 1000);
      for (const ev of batch) {
        write({ type: "job.event", event: ev }, ev.seq);
        lastSeq = ev.seq;
      }
      if (batch.length < 1000) break;
    }
    write({ type: "hello", lastSeq, version: app.startedAt });
    const onEvent = (ev: Record<string, unknown>) => {
      if (ev.type === "job.event") {
        const seq = (ev.event as { seq: number }).seq;
        if (seq <= lastSeq) return;
        lastSeq = seq;
        write(ev, seq);
      } else write(ev);
    };
    app.bus.on("event", onEvent);
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
    const clientId = c.client!.id;
    const close = () => {
      clearInterval(ping);
      app.bus.off("event", onEvent);
      app.streams.get(clientId)?.delete(close);
      if (!res.writableEnded) res.end();
    };
    if (!app.streams.has(clientId)) app.streams.set(clientId, new Set());
    app.streams.get(clientId)!.add(close);
    c.req.on("close", close);
    return undefined;
  });

  // ---- attention → drafts, briefings ----------------------------------------------------
  r.post("/attention/:id/draft", async (c) => {
    requireFeature(app, "drafts");
    const body = await c.body(z.object({ instructions: z.string().max(2000).optional() }));
    const item = getItem(app.db, c.params.id!);
    if (!item) throw new HttpError(404, "not_found", "Attention item not found");
    if (!item.draftable) throw new HttpError(409, "not_draftable", "Jarvis cannot draft a response for this kind of item.");
    const { job } = app.jobs.create({ kind: "draft", title: `Prepare draft: ${item.title}`.slice(0, 200), input: { attentionItemId: item.id, ...(body.instructions ? { instructions: body.instructions } : {}) }, capability: "drafts", connectionId: item.connectionId });
    return { __status: 201, body: { job } };
  });
  r.post("/briefings", async (c) => {
    requireFeature(app, "attention");
    const body = await c.body(z.object({ kind: z.enum(["daily", "away", "manual"]).default("manual"), since: z.string().datetime().optional() }));
    const { job } = app.jobs.create({ kind: "briefing", title: body.kind === "away" ? "Away summary" : "Briefing", input: { kind: body.kind, ...(body.since ? { since: body.since } : {}) }, capability: "attention" });
    return { __status: 201, body: { job } };
  });

  // ---- actions (drafts and approvals) ---------------------------------------------------
  r.get("/actions", (c) => {
    requireFeature(app, "drafts");
    app.actions.expireStale();
    return app.actions.list({ ...(c.query("status") ? { status: c.query("status")!.split(",") } : {}), limit: Number(c.query("limit") ?? 100) });
  });
  r.get("/actions/:id", (c) => {
    app.actions.expireStale();
    const a = app.actions.get(c.params.id!);
    if (!a) throw new HttpError(404, "not_found", "Action not found");
    return a;
  });
  r.put("/actions/:id", async (c) => {
    requireFeature(app, "drafts");
    const body = await c.body(ActionEditInput);
    const out = app.actions.edit(c.params.id!, body.payload, body.expectedVersion, c.client!.id);
    app.bus.emit("event", { type: "actions.changed", id: out.id });
    return out;
  });
  r.post("/actions/:id/approve", async (c) => {
    requireFeature(app, "drafts");
    app.actions.expireStale();
    const body = await c.body(ActionApproveInput);
    const out = app.actions.approve(c.params.id!, body.version, body.payloadHash, c.client!.id);
    app.bus.emit("event", { type: "actions.changed", id: out.id });
    return out;
  });
  r.post("/actions/:id/reject", async (c) => {
    requireFeature(app, "drafts");
    const body = await c.body(z.object({ reason: z.string().max(500).optional() }));
    const out = app.actions.reject(c.params.id!, c.client!.id, body.reason);
    app.bus.emit("event", { type: "actions.changed", id: out.id });
    return out;
  });
  r.post("/actions/:id/revoke", (c) => {
    const out = app.actions.revoke(c.params.id!, c.client!.id);
    app.bus.emit("event", { type: "actions.changed", id: out.id });
    return out;
  });
  r.post("/actions/:id/execute", async (c) => {
    requireFeature(app, "drafts");
    const body = await c.body(ActionExecuteInput);
    const a = app.actions.beginExecution(c.params.id!, body, c.client!.id);
    const { job } = app.jobs.create({ kind: "action", title: `Execute: ${a.title}`.slice(0, 200), input: { actionId: a.id }, capability: "drafts", connectionId: a.connectionId, maxAttempts: 1, idempotencyKey: `execute:${a.id}:v${a.version}` });
    app.bus.emit("event", { type: "actions.changed", id: a.id });
    return { __status: 202, body: { action: a, job } };
  });

  // ---- connections ------------------------------------------------------------------------
  r.get("/connections", () => app.connections.statuses());
  r.post("/connections/:kind/configure", async (c) => {
    const kind = ConnectionKind.parse(c.params.kind);
    const body = await c.body(z.object({ method: z.string().max(50), fields: z.record(z.string(), z.string().max(10_000)).default({}), readScopes: z.array(z.string()).optional() }));
    const fields: Record<string, string> = { ...body.fields, method: body.method };
    if (kind === "speech") fields.whisperModelPath = app.speech.modelPath;
    const out = await app.connections.configure(kind, fields, body.readScopes);
    if (kind === "model") await app.refreshModel();
    return out;
  });
  r.post("/connections/:id/test", async (c) => {
    const before = app.connections.requireRecord(c.params.id!).status;
    const out = await app.connections.test(c.params.id!);
    const rec = app.connections.requireRecord(c.params.id!);
    if (rec.kind === "model") await app.refreshModel();
    // A connection that just recovered still shows the failed coverage of its last sync: refresh it now.
    if (out.ok && (before === "needs_auth" || before === "error") && rec.readScopes.length && app.featureEnabled("attention")) {
      app.jobs.create({ kind: "sync", title: `Refresh ${rec.label}`, input: { connectionId: rec.id }, capability: "attention", connectionId: rec.id });
    }
    return { test: out, status: app.connections.status(app.connections.requireRecord(c.params.id!)) };
  });
  r.put("/connections/:id/scopes", async (c) => {
    const body = await c.body(z.object({ readScopes: z.array(z.string()) }));
    return app.connections.setScopes(c.params.id!, body.readScopes);
  });
  r.put("/connections/:id/write-actions", async (c) => {
    const body = await c.body(z.object({ writeActions: z.array(z.string()), confirm: z.literal(true) }));
    const rec = app.connections.requireRecord(c.params.id!);
    const removed = rec.writeActions.filter((a) => !body.writeActions.includes(a));
    const out = app.connections.setWriteActions(c.params.id!, body.writeActions);
    const revoked = removed.length ? app.actions.revokeWhere((a) => a.connectionId === rec.id && removed.includes(a.kind), "write permission removed") : [];
    return { ...out, revoked };
  });
  r.get("/connections/:id/disconnect-preview", (c) => app.connections.disconnectEffects(c.params.id!));
  r.post("/connections/:id/disconnect", async (c) => {
    const body = await c.body(z.object({ deleteData: z.boolean() }));
    const kind = app.connections.record(c.params.id!)?.kind;
    const out = await app.connections.disconnect(c.params.id!, body);
    if (kind === "model") await app.refreshModel();
    return out;
  });
  r.post("/connections/:id/sync", (c) => {
    requireFeature(app, "attention");
    const rec = app.connections.requireRecord(c.params.id!);
    if (rec.status === "disconnected") throw new HttpError(409, "disconnected", "Reconnect this source first.");
    const { job } = app.jobs.create({ kind: "sync", title: `Refresh ${rec.label}`, input: { connectionId: rec.id }, capability: "attention", connectionId: rec.id });
    return { __status: 201, body: { job } };
  });
  r.post("/connections/:kind/oauth/start", async (c) => {
    const kind = ConnectionKind.parse(c.params.kind);
    const rec = app.connections.requireRecord(kind);
    const adapter = app.connections.adapter(kind);
    if (!adapter.authorizeUrl) throw new HttpError(400, "not_oauth", `${adapter.definition.label} does not use browser sign-in`);
    const body = await c.body(z.object({ includeWrite: z.boolean().default(false) }));
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const redirectUri = `http://127.0.0.1:${port()}${API_PREFIX}/oauth/callback`;
    const scopes = adapter.oauthScopes?.(body.includeWrite) ?? [];
    const { url, settings } = await adapter.authorizeUrl(app.connections.context(rec), { redirectUri, state, codeChallenge: challenge, scopes });
    oauthPending.set(state, { kind, verifier, redirectUri, expires: Date.now() + 10 * 60_000, settings: settings ?? {} });
    return { url, redirectUri };
  });
  r.get(
    "/oauth/callback",
    async (c) => {
      const state = c.query("state") ?? "";
      const pending = oauthPending.get(state);
      oauthPending.delete(state);
      const back = (msg: string, ok: boolean) => {
        c.res.writeHead(302, { location: `/connections?oauth=${ok ? "ok" : "error"}&message=${encodeURIComponent(msg)}` });
        c.res.end();
        return undefined;
      };
      if (!pending || pending.expires < Date.now()) return back("Sign-in expired or was not started here. Try again.", false);
      if (c.query("error")) return back(`The provider returned: ${c.query("error")}`, false);
      const code = c.query("code");
      if (!code) return back("No authorization code returned", false);
      const rec = app.connections.requireRecord(pending.kind);
      const adapter = app.connections.adapter(pending.kind);
      try {
        // Exchange the code with the client this sign-in started with; persist it only now that it worked.
        const started = { ...rec, settings: { ...rec.settings, ...pending.settings } };
        const res = await adapter.completeAuthorization!(app.connections.context(started), { code, redirectUri: pending.redirectUri, codeVerifier: pending.verifier });
        app.connections.mergeSettings(rec.id, { ...pending.settings, ...res.settings });
        if (res.account) app.db.prepare("update connections set account = ? where id = ?").run(res.account, rec.id);
        const t = await app.connections.test(rec.id);
        return back(t.ok ? `Connected ${adapter.definition.label}` : t.message, t.ok);
      } catch (e) {
        return back((e as Error).message, false);
      }
    },
    { public: true },
  );

  r.post("/import/preview", async (c) => {
    requireFeature(app, "capture");
    const { path } = await c.body(z.object({ path: z.string().min(1) }));
    return app.connections.previewImport(path.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  });
  r.post("/import", async (c) => {
    requireFeature(app, "capture");
    const body = await c.body(z.object({ path: z.string().min(1), label: z.string().max(100).optional() }));
    const { status } = await app.connections.configure("vault", { path: body.path, method: "folder", label: body.label ?? (body.path.replace(/\/+$/, "").split("/").pop() || "Imported notes") });
    const { job } = app.jobs.create({ kind: "import", title: `Import ${status.label}`, input: { connectionId: status.id }, capability: "capture", connectionId: status.id });
    return { __status: 201, body: { connection: status, job } };
  });
  r.post("/memory/reindex", () => {
    requireFeature(app, "recall");
    const { job } = app.jobs.create({ kind: "reindex", title: "Rebuild search index", input: {}, capability: "recall" });
    return { __status: 201, body: { job } };
  });

  // ---- voice ---------------------------------------------------------------------------------
  r.get("/voice/status", async () => ({ enabled: app.featureEnabled("voice"), modes: await app.speech.clientModes(), environment: app.speech.environment(), voices: await app.speech.voices() }));
  r.post("/voice/model/download", () => {
    void app.speech.downloadModel();
    return { __status: 202, body: { download: app.speech.environment().download } };
  });
  r.post("/voice/transcribe", async (c) => {
    requireFeature(app, "voice");
    const audio = await c.raw(20 * 1024 * 1024);
    try {
      const text = await app.speech.transcribe(audio);
      return { text };
    } catch (e) {
      if (e instanceof SpeechError) throw new HttpError(e.kind === "not_configured" ? 409 : e.kind === "invalid" ? 400 : 503, `speech_${e.kind}`, e.message);
      throw e;
    }
  });
  r.post("/voice/speak", async (c) => {
    requireFeature(app, "voice");
    const { text } = await c.body(z.object({ text: z.string().min(1).max(8000) }));
    try {
      const out = await app.speech.synthesize(text);
      return { __raw: out.audio, mime: out.mime };
    } catch (e) {
      if (e instanceof SpeechError) throw new HttpError(e.kind === "not_configured" ? 409 : e.kind === "invalid" ? 400 : 503, `speech_${e.kind}`, e.message);
      throw e;
    }
  });

  // ---- backup ---------------------------------------------------------------------------------
  r.get("/backups", () => listBackups(app));
  r.post("/backups", async () => ({ __status: 201, body: await createBackup(app) }));
}

function defaultTitle(kind: JobKind, input: Record<string, unknown>): string {
  if (kind === "research") return `Research: ${String(input.question ?? "").slice(0, 120)}`;
  if (kind === "demo-long") return "Diagnostics: long-running self-test";
  if (kind === "sync") return "Refresh sources";
  if (kind === "reindex") return "Rebuild search index";
  if (kind === "briefing") return "Briefing";
  return kind;
}
