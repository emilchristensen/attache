import { z } from "zod";
import { AttentionDecision, CaptureInput, ChatInput, CorrectionInput, MemoryCreateInput, type FeatureId } from "@jarvis/contracts";
import type { Router } from "./router.ts";
import { HttpError } from "./router.ts";
import type { App } from "../app.ts";
import { search } from "../memory/search.ts";
import { decide, getItem, listItems } from "../attention/engine.ts";
import { latestBriefing } from "../attention/briefing.ts";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveInside } from "../memory/policy.ts";
import { parseMarkdown, parseStateEntries } from "../memory/markdown.ts";
import { json } from "../core/db.ts";

export function requireFeature(app: App, id: FeatureId) {
  if (!app.featureEnabled(id)) throw new HttpError(409, "feature_disabled", `${app.featureLabel(id)} is turned off. Turn it on in Settings.`, { feature: id });
}

function requireData(app: App) {
  if (!app.memory.dataRoot) throw new HttpError(409, "needs_data_folder", "Choose a data folder first.");
}

function rootPath(app: App, root: string): string {
  if (root === "data") {
    requireData(app);
    return app.memory.dataRoot!;
  }
  const id = root.replace(/^import:/, "");
  const rec = app.connections.record(id);
  if (!rec || rec.kind !== "vault") throw new HttpError(404, "not_found", "Unknown source folder");
  return String(rec.settings.path);
}

export function registerDataRoutes(r: Router, app: App) {
  // ---- memory ------------------------------------------------------------------
  r.get("/memory/search", (c) => {
    requireFeature(app, "recall");
    const q = c.query("q") ?? "";
    const area = c.query("area");
    const type = c.query("type");
    return { query: q, hits: search(app.db, q, { limit: Math.min(Number(c.query("limit") ?? 20), 50), ...(area ? { areas: [area] } : {}), ...(type ? { docTypes: [type] } : {}) }) };
  });
  r.get("/memory/documents", (c) => {
    requireFeature(app, "recall");
    return app.memory.listDocuments({ ...(c.query("area") ? { area: c.query("area")! } : {}), ...(c.query("type") ? { docType: c.query("type")! } : {}), ...(c.query("root") ? { root: c.query("root")! } : {}), limit: Number(c.query("limit") ?? 300) });
  });
  r.get("/memory/document", (c) => {
    requireFeature(app, "recall");
    const root = c.query("root") ?? "data";
    const rel = c.query("path");
    if (!rel) throw new HttpError(400, "invalid_request", "path is required");
    const base = rootPath(app, root);
    const abs = resolveInside(base, rel);
    if (!existsSync(abs)) throw new HttpError(404, "not_found", `${rel} no longer exists. The index will drop it on the next refresh.`);
    const raw = readFileSync(abs, "utf8");
    const parsed = parseMarkdown(raw, rel);
    const doc = app.db.prepare("select id, area, doc_type as docType, indexed_at as indexedAt from documents where root = ? and rel_path = ?").get(root, rel) as Record<string, unknown> | undefined;
    return {
      root,
      relPath: rel,
      absPath: join(base, rel),
      raw,
      title: parsed.title,
      frontmatter: parsed.frontmatter,
      state: parseStateEntries(raw),
      area: doc?.area ?? (root === "data" ? rel.split("/")[0] : "import"),
      docType: doc?.docType ?? null,
      indexedAt: doc?.indexedAt ?? null,
      editable: root === "data" && rel.startsWith("memory/") && rel !== "memory/self.md",
      protected: root === "data" && rel === "memory/self.md",
      changes: root === "data" ? app.memory.listChanges({ relPath: rel, limit: 50 }) : [],
    };
  });
  r.post("/memory/capture", async (c) => {
    requireFeature(app, "capture");
    requireData(app);
    const input = await c.body(CaptureInput);
    const source = { ...input.source, label: input.source.label ?? `via ${c.client?.name ?? "client"}` };
    const cap = app.memory.capture({ text: input.text, ...(input.title ? { title: input.title } : {}), source, ...(input.tags ? { tags: input.tags } : {}) });
    let decision: { relPath: string } | null = null;
    if (input.decision) {
      decision = app.memory.recordDecision({ title: input.decision.title, decision: input.decision.decision, source: { kind: "capture", ref: cap.relPath, observedAt: new Date().toISOString(), label: input.title ?? "capture" }, ...(input.decision.project ? { project: input.decision.project } : {}) });
    }
    app.bus.emit("event", { type: "memory.changed" });
    return { capture: cap, decision };
  });
  r.post("/memory/notes", async (c) => {
    requireFeature(app, "capture");
    requireData(app);
    const input = await c.body(MemoryCreateInput);
    const out = app.memory.createMemory({ type: input.type, title: input.title, state: input.state, ...(input.notes ? { notes: input.notes } : {}), ...(input.sources ? { sources: input.sources } : {}) }, "user");
    app.bus.emit("event", { type: "memory.changed" });
    return out;
  });
  r.post("/memory/correct", async (c) => {
    requireFeature(app, "capture");
    requireData(app);
    const input = await c.body(CorrectionInput);
    if (!input.relPath.startsWith("memory/")) throw new HttpError(400, "not_memory", "Only curated memory notes can be corrected. Capture a new note for evidence.");
    const change = app.memory.correct(input.relPath, { subject: input.subject, value: input.value, reason: input.reason }, "user");
    app.bus.emit("event", { type: "memory.changed" });
    return { change, document: app.memory.describe(input.relPath) };
  });
  r.put("/memory/notes-body", async (c) => {
    requireFeature(app, "capture");
    const input = await c.body(z.object({ relPath: z.string().startsWith("memory/"), notes: z.string().max(100_000) }));
    app.memory.replaceNotes(input.relPath, input.notes);
    app.bus.emit("event", { type: "memory.changed" });
    return app.memory.describe(input.relPath);
  });
  r.get("/memory/changes", (c) => app.memory.listChanges({ ...(c.query("status") ? { status: c.query("status")! } : {}), limit: Number(c.query("limit") ?? 100) }));
  r.post("/memory/proposals", async (c) => {
    requireFeature(app, "capture");
    const input = await c.body(z.object({ relPath: z.string().nullable(), subject: z.string().min(1).max(100), value: z.string().min(1).max(5000), reason: z.string().min(1).max(1000), source: z.string().max(500), newDoc: z.object({ type: z.enum(["person", "project", "decision", "note"]), title: z.string().min(1).max(200) }).optional() }));
    return app.memory.propose({ docRelPath: input.relPath, subject: input.subject, value: input.value, reason: input.reason, source: input.source, actor: "model", ...(input.newDoc ? { newDoc: input.newDoc } : {}) });
  });
  r.post("/memory/proposals/:id/:decision", (c) => {
    requireFeature(app, "capture");
    const d = c.params.decision;
    if (d !== "apply" && d !== "reject") throw new HttpError(400, "invalid_request", "decision must be apply or reject");
    const out = app.memory.decideProposal(c.params.id!, d);
    app.bus.emit("event", { type: "memory.changed" });
    return out;
  });
  r.get("/memory/entities", () => {
    requireFeature(app, "recall");
    const docs = app.db.prepare("select id, rel_path as relPath, doc_type as docType, title, meta, mtime_ms as mtimeMs from documents where root = 'data' and area = 'memory' order by title collate nocase").all() as Array<Record<string, unknown>>;
    const byType: Record<string, unknown[]> = { person: [], project: [], decision: [], note: [] };
    for (const d of docs) {
      const t = String(d.docType ?? "note");
      const state = app.db.prepare("select text from chunks c where c.doc_id = ? and c.section = 'state' order by ordinal limit 1").get(String(d.id)) as { text: string } | undefined;
      (byType[t] ??= []).push({ ...d, meta: json(d.meta, {}), stateText: state?.text ?? "" });
    }
    return byType;
  });

  // ---- conversation ----------------------------------------------------------------
  r.get("/conversations", () => app.conversations.listConversations());
  r.get("/conversations/:id/messages", (c) => app.conversations.messages(c.params.id!));
  r.post("/chat", async (c) => {
    requireFeature(app, "conversation");
    requireData(app);
    const input = await c.body(ChatInput);
    await app.model();
    return app.conversations.send({ conversationId: input.conversationId ?? null, text: input.text, ...(input.context ? { context: input.context } : {}), clientId: c.client!.id });
  });
  r.get("/messages/:id", (c) => {
    const m = app.conversations.message(c.params.id!);
    if (!m) throw new HttpError(404, "not_found", "Message not found");
    return m;
  });
  r.post("/messages/:id/cancel", (c) => ({ cancelled: app.conversations.cancel(c.params.id!) }));

  // ---- attention ---------------------------------------------------------------------
  r.get("/attention", (c) => {
    requireFeature(app, "attention");
    const states = (c.query("state") ?? "open").split(",").filter(Boolean);
    return { items: listItems(app.db, { states, limit: Number(c.query("limit") ?? 200) }) };
  });
  r.post("/attention/:id/decision", async (c) => {
    requireFeature(app, "attention");
    const body = await c.body(AttentionDecision);
    if (!getItem(app.db, c.params.id!)) throw new HttpError(404, "not_found", "Attention item not found");
    try {
      const item = decide(app.db, c.params.id!, body.decision, c.client!.id, body.until);
      app.bus.emit("event", { type: "attention.changed" });
      return item;
    } catch (e) {
      throw new HttpError(400, "invalid_decision", (e as Error).message);
    }
  });
  r.get("/briefings/latest", () => {
    requireFeature(app, "attention");
    return { briefing: latestBriefing(app.db) };
  });
}
