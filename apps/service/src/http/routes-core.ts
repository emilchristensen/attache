import { existsSync, mkdirSync, accessSync, constants, statSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { z } from "zod";
import { ConfigPatch, FeatureId } from "@jarvis/contracts";
import type { Router } from "./router.ts";
import { HttpError } from "./router.ts";
import type { App } from "../app.ts";
import { VERSION } from "../app.ts";
import { createPairingCode, redeemPairingCode, sessionCookie, clearedCookie } from "./security.ts";
import { resolveChange, effectiveFeatures } from "../capabilities/registry.ts";
import { planScan } from "../memory/indexer.ts";
import { nowIso } from "../core/db.ts";

const expandHome = (p: string) => p.replace(/^~(?=\/|$)/, process.env.HOME ?? "~");

export function dataFolderPreview(path: string) {
  const abs = resolve(expandHome(path));
  if (!isAbsolute(abs)) throw new HttpError(400, "invalid_path", "Use an absolute folder path");
  const exists = existsSync(abs);
  if (exists && !statSync(abs).isDirectory()) throw new HttpError(400, "not_a_folder", `${abs} is a file, not a folder`);
  let writable = true;
  let parent = abs;
  while (!existsSync(parent)) parent = resolve(parent, "..");
  try {
    accessSync(parent, constants.W_OK);
  } catch {
    writable = false;
  }
  const plan = exists ? planScan(abs) : { read: [], skipped: [], totalBytes: 0 };
  const willCreate = ["memory/", "evidence/", "deliverables/", "README.md", ".jarvis/"].filter((d) => !existsSync(resolve(abs, d)));
  return {
    path: abs,
    exists,
    writable,
    markdownFiles: plan.read.length,
    sample: plan.read.slice(0, 10),
    willCreate,
    willModify: [] as string[],
    note: exists
      ? `Jarvis will add ${willCreate.length ? willCreate.join(", ") : "nothing new"} and index ${plan.read.length} existing Markdown file(s). Existing files are not modified.`
      : "Jarvis will create this folder with memory/, evidence/ and deliverables/.",
  };
}

export function registerCoreRoutes(r: Router, app: App, port: () => number) {
  r.get(
    "/health",
    () => ({ ok: true, service: "jarvis", version: VERSION, api: "v1", setupCompleted: app.config.get().setupCompleted, time: nowIso() }),
    { public: true },
  );

  r.post(
    "/pair",
    async (c) => {
      const body = await c.body(z.object({ code: z.string().min(6).max(20), clientName: z.string().max(100).default("Browser"), kind: z.enum(["browser", "obsidian", "cli", "electron"]).default("browser") }));
      const redeemed = redeemPairingCode(app.db, body.code, { name: body.clientName, kind: body.kind });
      if (!redeemed) throw new HttpError(401, "invalid_code", "That pairing code is wrong, expired or already used. Create a new one.");
      app.db.prepare("insert into audit (at, actor, event, data) values (?,?,?,?)").run(nowIso(), redeemed.client.id, "client_paired", JSON.stringify({ name: body.clientName, kind: body.kind }));
      if (body.kind === "browser") return { __status: 200, body: { client: redeemed.client }, headers: { "set-cookie": sessionCookie(redeemed.token) } };
      return { client: redeemed.client, token: redeemed.token };
    },
    { public: true },
  );

  r.get("/session", (c) => ({ client: c.client, version: VERSION, instance: app.instance, port: port() }));
  r.post("/session/logout", (c) => {
    app.db.prepare("update clients set revoked_at = ? where id = ?").run(nowIso(), c.client!.id);
    app.closeStreams(c.client!.id);
    return { __status: 200, body: { ok: true }, headers: { "set-cookie": clearedCookie } };
  });
  r.get("/clients", () => app.db.prepare("select id, name, kind, created_at as createdAt, last_seen_at as lastSeenAt, revoked_at as revokedAt from clients order by created_at desc").all());
  r.post("/clients/pairing-code", () => createPairingCode(app.db));
  r.delete("/clients/:id", (c) => {
    app.db.prepare("update clients set revoked_at = ? where id = ?").run(nowIso(), c.params.id!);
    app.closeStreams(c.params.id!);
    return { ok: true };
  });

  r.get("/config", () => ({ config: app.config.get(), revision: app.config.revision(), features: app.effectiveFeatures() }));
  r.patch("/config", async (c) => {
    const patch = await c.body(ConfigPatch.omit({ features: true }));
    const next = app.config.patch(patch);
    app.scheduler.reconcile(next);
    app.bus.emit("event", { type: "config.changed" });
    return { config: next, revision: app.config.revision() };
  });

  r.get("/capabilities", () => ({
    features: app.featureStatuses(),
    connections: app.connections.statuses(),
    definitions: [...app.connectionKinds()].map((k) => app.connections.adapter(k).definition),
  }));

  r.put("/features", async (c) => {
    const body = await c.body(z.object({ changes: z.partialRecord(FeatureId, z.boolean()), cascade: z.boolean().default(false) }));
    const before = app.effectiveFeatures();
    const result = resolveChange(app.config.get().features, body.changes, body.cascade);
    if (result.problems.length) {
      throw new HttpError(409, "dependency", result.problems.map((p) => p.message).join(" "), { problems: result.problems, fix: "Retry with cascade: true to turn on required features (or turn off dependent ones)." });
    }
    app.config.patch({ features: result.next });
    const effects = app.applyFeatureChange(before, effectiveFeatures(result.next));
    return { features: app.featureStatuses(), added: result.added, removed: result.removed, effects };
  });

  r.get("/setup/defaults", () => {
    const home = process.env.HOME ?? "";
    return { home, suggestion: `${home}/Documents/Jarvis` };
  });
  r.post("/setup/data-folder/preview", async (c) => {
    const { path } = await c.body(z.object({ path: z.string().min(1) }));
    return dataFolderPreview(path);
  });
  r.post("/setup/data-folder", async (c) => {
    const { path } = await c.body(z.object({ path: z.string().min(1) }));
    const preview = dataFolderPreview(path);
    if (!preview.writable) throw new HttpError(400, "not_writable", `Jarvis cannot write to ${preview.path}`);
    mkdirSync(preview.path, { recursive: true });
    const { created } = app.openDataFolder(preview.path);
    app.config.patch({ dataFolder: preview.path });
    app.bus.emit("event", { type: "config.changed" });
    return { path: preview.path, created, indexed: app.memory.listDocuments({ root: "data", limit: 2000 }).length };
  });
  r.post("/setup/identity", async (c) => {
    const body = await c.body(z.object({ name: z.string().min(1).max(100), email: z.string().max(200).default(""), confirm: z.literal(true) }));
    app.config.patch({ identity: { name: body.name, email: body.email } });
    if (app.memory.dataRoot) app.memory.writeIdentity({ name: body.name, ...(body.email ? { email: body.email } : {}) }, body.confirm);
    return { identity: app.config.get().identity };
  });
  r.post("/setup/complete", () => {
    const cfg = app.config.get();
    if (!cfg.dataFolder) throw new HttpError(409, "needs_data_folder", "Choose a data folder before finishing setup.");
    const next = app.config.patch({ setupCompleted: true });
    app.scheduler.reconcile(next);
    if (app.featureEnabled("attention")) app.jobs.create({ kind: "sync", title: "First refresh of your sources", input: { all: true, reason: "setup" }, capability: "attention", idempotencyKey: "setup:first-sync" });
    app.bus.emit("event", { type: "config.changed" });
    return { config: next, features: app.featureStatuses() };
  });
  r.post("/setup/test", async () => {
    const results: Array<{ id: string; label: string; kind: string; ok: boolean; state: string; message: string }> = [];
    for (const rec of app.connections.records().filter((x) => x.status !== "disconnected")) {
      const t = await app.connections.test(rec.id);
      results.push({ id: rec.id, label: rec.label, kind: rec.kind, ok: t.ok, state: t.state, message: t.message });
    }
    await app.refreshModel();
    return { connections: results, features: app.featureStatuses() };
  });

  r.get("/status", () => {
    const counts = app.db.prepare("select status, count(*) n from jobs group by status").all();
    return {
      version: VERSION,
      instance: app.instance,
      startedAt: app.startedAt,
      pid: process.pid,
      node: process.version,
      stateDir: app.paths.stateDir,
      dataFolder: app.config.get().dataFolder,
      credentialStore: app.secrets.kind,
      documents: Number((app.db.prepare("select count(*) n from documents").get() as { n: number }).n),
      jobs: counts,
      schedules: app.scheduler.list(),
      connections: app.connections.statuses().map((s) => ({ id: s.id, kind: s.kind, status: s.status, lastSuccessAt: s.lastSuccessAt, lastError: s.lastError, coverage: s.coverage?.state ?? null })),
      features: app.featureStatuses().map((f) => ({ id: f.id, enabled: f.enabled, readiness: f.readiness, reason: f.reason })),
    };
  });
}
