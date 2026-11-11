import { z } from "zod";
import { ArchiveInput, AttentionDecision, CaptureInput, CorrectionInput, MemoryCreateInput, MemorySaveInput, MemorySaveProposalInput, ProposalInput, type FeatureId, type RecentChangesResult } from "@jarvis/contracts";
import type { Router } from "./router.ts";
import { HttpError } from "./router.ts";
import type { App } from "../app.ts";
import { RECALL_EXCLUDE, search } from "../memory/search.ts";
import { decide, getItem, listItems } from "../attention/engine.ts";
import { latestBriefing } from "../attention/briefing.ts";
import { readFileSync, existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { resolveInside } from "../memory/policy.ts";
import { parseMarkdown, parseStateEntries } from "../memory/markdown.ts";
import { json } from "../core/db.ts";
import { checkSave, proposeSave, saveToMemory } from "../memory/save.ts";
import { decideProposal, listProposals, proposeItem } from "../memory/proposals.ts";
import { auditMemory, DEFAULT_STALE_DAYS } from "../memory/audit.ts";
import { expandHome } from "../platform/locations.ts";
import { recentChanges } from "../memory/recent-changes.ts";
import { revertChange } from "../memory/revert.ts";

const PROPOSAL_STATUSES = ["proposed", "applied", "rejected"];

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

export function memoryRoots(app: App): Array<{ root: string; path: string; label: string }> {
  const out: Array<{ root: string; path: string; label: string }> = [];
  if (app.memory.dataRoot) out.push({ root: "data", path: app.memory.dataRoot, label: "Jarvis data folder" });
  for (const rec of app.connections.records()) {
    if (rec.kind === "vault" && !rec.settings.builtin && rec.status !== "disconnected") out.push({ root: `import:${rec.id}`, path: String(rec.settings.path), label: rec.label });
  }
  return out;
}

/** Map an absolute file path (e.g. a note open in an editor) to an indexed root and relative path. */
export function resolveAbsolute(app: App, absPath: string): { root: string; relPath: string } | null {
  const norm = absPath.replace(/\\/g, "/");
  const roots = memoryRoots(app).sort((a, b) => b.path.length - a.path.length);
  for (const r of roots) {
    const base = r.path.replace(/\/+$/, "") + "/";
    if (norm.startsWith(base)) return { root: r.root, relPath: norm.slice(base.length) };
  }
  return null;
}

/** The note a document request names: a root and a path inside it, or an absolute path inside the Brain or another indexed folder. */
function documentTarget(app: App, root: string | null | undefined, path: string | null | undefined): { root: string; rel: string } {
  if (!path) throw new HttpError(400, "invalid_request", "path is required");
  if (root || !isAbsolute(path)) return { root: root ?? "data", rel: path };
  const found = resolveAbsolute(app, path);
  if (!found) throw new HttpError(404, "not_found", `${path} is not in the Brain or another folder Jarvis indexes.`);
  return { root: found.root, rel: found.relPath };
}

export function registerDataRoutes(r: Router, app: App) {
  // ---- memory ------------------------------------------------------------------
  r.get("/memory/search", (c) => {
    requireFeature(app, "recall");
    const q = c.query("q") ?? "";
    const area = c.query("area");
    const type = c.query("type");
    // `recall=1` searches the way recall does: old chat archives and session transcripts stay out, their summaries stay in.
    const recall = c.query("recall") === "1";
    return { query: q, meaning: app.meaning.status(), hits: search(app.db, q, { limit: Math.min(Number(c.query("limit") ?? 20), 50), ...(area ? { areas: [area] } : {}), ...(type ? { docTypes: [type] } : {}), ...(recall ? { excludePrefixes: RECALL_EXCLUDE } : {}) }) };
  });
  r.get("/memory/documents", (c) => {
    requireFeature(app, "recall");
    return app.memory.listDocuments({ ...(c.query("area") ? { area: c.query("area")! } : {}), ...(c.query("type") ? { docType: c.query("type")! } : {}), ...(c.query("root") ? { root: c.query("root")! } : {}), limit: Number(c.query("limit") ?? 300) });
  });
  r.get("/memory/document", (c) => {
    requireFeature(app, "recall");
    const { root, rel } = documentTarget(app, c.query("root"), c.query("path"));
    const base = rootPath(app, root);
    const abs = resolveInside(base, rel);
    if (!existsSync(abs)) throw new HttpError(404, "not_found", `${rel} no longer exists. The index will drop it on the next refresh.`);
    const raw = readFileSync(abs, "utf8");
    const parsed = parseMarkdown(raw, rel);
    const doc = app.db.prepare("select id, area, doc_type as docType, indexed_at as indexedAt from documents where root = ? and rel_path = ?").get(root, rel) as Record<string, unknown> | undefined;
    const rootLabel = root === "data" ? "Jarvis data folder" : (app.connections.record(root.replace(/^import:/, ""))?.label ?? root);
    return {
      root,
      rootLabel,
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
    const out = app.memory.createMemory(
      {
        type: input.type,
        title: input.title,
        state: input.state.map((e) => ({ subject: e.subject, value: e.value, ...(e.date ? { date: e.date } : {}), ...(e.source ? { source: e.source } : {}) })),
        ...(input.notes ? { notes: input.notes } : {}),
        ...(input.sources ? { sources: input.sources } : {}),
        ...(input.history ? { history: input.history } : {}),
        ...(input.provenance ? { provenance: input.provenance } : {}),
        ...(input.tags ? { tags: input.tags } : {}),
      },
      "user",
    );
    app.bus.emit("event", { type: "memory.changed" });
    return out;
  });
  r.post("/memory/archive", async (c) => {
    requireFeature(app, "capture");
    requireData(app);
    const input = await c.body(ArchiveInput);
    const path = resolve(expandHome(input.path));
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new HttpError(400, "not_found", `Folder not found: ${path}`);
    const out = app.memory.archiveFolder({ path, label: input.label, exclude: input.exclude, ...(input.origin ? { origin: input.origin } : {}) });
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
  r.post("/memory/save", async (c) => {
    requireFeature(app, "capture");
    requireData(app);
    const input = await c.body(MemorySaveInput);
    const out = saveToMemory(app, input, c.client?.id ?? null);
    app.bus.emit("event", { type: "memory.changed" });
    return out;
  });
  r.post("/memory/save/check", async (c) => {
    requireFeature(app, "capture");
    requireData(app);
    const input = await c.body(MemorySaveInput);
    return checkSave(app, input.items);
  });
  r.post("/memory/save/proposals", async (c) => {
    requireFeature(app, "capture");
    requireData(app);
    const input = await c.body(MemorySaveProposalInput);
    const out = proposeSave(app, input);
    app.bus.emit("event", { type: "memory.changed" });
    return out;
  });
  r.get("/memory/audit", (c) => {
    requireFeature(app, "recall");
    requireData(app);
    const days = Number(c.query("staleDays") ?? DEFAULT_STALE_DAYS);
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new HttpError(400, "invalid_request", "staleDays must be a whole number of days between 1 and 3650");
    return auditMemory(app, { staleDays: days });
  });
  r.put("/memory/notes-body", async (c) => {
    requireFeature(app, "capture");
    const input = await c.body(z.object({ relPath: z.string().startsWith("memory/"), notes: z.string().max(100_000) }));
    app.memory.replaceNotes(input.relPath, input.notes);
    app.bus.emit("event", { type: "memory.changed" });
    return app.memory.describe(input.relPath);
  });
  r.get("/memory/recent-changes", (c): RecentChangesResult => {
    requireFeature(app, "recall");
    requireData(app);
    const limit = Number(c.query("limit") ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new HttpError(400, "invalid_request", "limit must be a whole number between 1 and 200");
    return { changes: recentChanges(app.db, app.memory, limit) };
  });
  r.post("/memory/changes/:id/revert", (c) => {
    requireFeature(app, "capture");
    requireData(app);
    const change = revertChange(app.memory, c.params.id!);
    app.bus.emit("event", { type: "memory.changed" });
    return { change: recentChanges(app.db, app.memory, 1).find((v) => v.id === change.id) ?? null };
  });
  r.get("/memory/changes", (c) => app.memory.listChanges({ ...(c.query("status") ? { status: c.query("status")! } : {}), limit: Number(c.query("limit") ?? 100) }));
  r.get("/memory/proposals", (c) => {
    const status = c.query("status") ?? "proposed";
    if (!PROPOSAL_STATUSES.includes(status)) throw new HttpError(400, "invalid_request", `status must be one of ${PROPOSAL_STATUSES.join(", ")}`);
    return { proposals: listProposals(app.memory, { status, limit: Number(c.query("limit") ?? 100) }) };
  });
  r.post("/memory/proposals", async (c) => {
    requireFeature(app, "capture");
    const input = await c.body(ProposalInput);
    const out = proposeItem(app.memory, input, "model");
    app.bus.emit("event", { type: "memory.changed" });
    return out;
  });
  r.post("/memory/proposals/:id/:decision", (c) => {
    requireFeature(app, "capture");
    const d = c.params.decision;
    if (d !== "apply" && d !== "reject") throw new HttpError(400, "invalid_request", "decision must be apply or reject");
    const out = decideProposal(app.memory, c.params.id!, d);
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

  r.get("/memory/roots", () => memoryRoots(app));

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
