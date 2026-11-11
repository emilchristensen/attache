import { ArchiveInput, AttentionDecision, MemorySaveInput, MemorySaveProposalInput, ProposalInput, type FeatureId, type ProposalView, type RecentChangesResult } from "@jarvis/contracts";
import type { Router } from "./router.ts";
import { HttpError } from "./router.ts";
import type { App } from "../app.ts";
import { RECALL_EXCLUDE, searchByMeaning } from "../memory/search.ts";
import { getItem, listItems } from "../attention/engine.ts";
import { latestBriefing } from "../attention/briefing.ts";
import { readFileSync, existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { resolveInside } from "../memory/policy.ts";
import { parseMarkdown, parseStateEntries, toLf } from "../memory/markdown.ts";
import { isPastReview } from "../memory/review-date.ts";
import { json } from "../core/db.ts";
import { checkSave, proposeSave, saveToMemory } from "../memory/save.ts";
import { auditMemory } from "../memory/audit.ts";
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
  const roots = memoryRoots(app).sort((a, b) => b.path.length - a.path.length);
  for (const r of roots) {
    // `relative` knows the separators and, on Windows, that case does not matter.
    const rel = relative(r.path, absPath);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return { root: r.root, relPath: rel.split(sep).join("/") };
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
  r.get("/memory/search", async (c) => {
    requireFeature(app, "recall");
    const q = c.query("q") ?? "";
    const area = c.query("area");
    const type = c.query("type");
    // `recall=1` searches the way recall does: old chat archives and session transcripts stay out, their summaries stay in.
    const recall = c.query("recall") === "1";
    const hits = await searchByMeaning(app.db, q, (query, n) => app.meaning.nearest(query, n), { limit: Math.min(Number(c.query("limit") ?? 20), 50), ...(area ? { areas: [area] } : {}), ...(type ? { docTypes: [type] } : {}), ...(recall ? { excludePrefixes: RECALL_EXCLUDE } : {}) });
    // Read after searching, so a model that failed while ranking is reported with these results.
    return { query: q, meaning: app.meaning.status(), hits };
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
    const raw = toLf(readFileSync(abs, "utf8"));
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
      state: parseStateEntries(raw).map((e) => ({ ...e, unverified: isPastReview(e.review) })),
      area: doc?.area ?? (root === "data" ? rel.split("/")[0] : "import"),
      docType: doc?.docType ?? null,
      indexedAt: doc?.indexedAt ?? null,
      protected: root === "data" && rel === "memory/self.md",
      changes: root === "data" ? app.memory.listChanges({ relPath: rel, limit: 50 }) : [],
    };
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
  r.post("/memory/save", async (c) => {
    requireFeature(app, "capture");
    requireData(app);
    // The Dashboard shows and decides (ADR 0003): only a Harness, through the MCP server and the CLI token, saves.
    if (c.client?.kind !== "cli") throw new HttpError(403, "dashboard_cannot_save", "The Dashboard does not write to the Brain. Save from a Harness, which asks you to confirm.");
    const input = await c.body(MemorySaveInput);
    const out = saveToMemory(app, input, c.client?.id ?? null);
    app.bus.emit("event", { type: "memory.changed" });
    return out;
  });
  r.post("/memory/save/check", async (c) => {
    requireFeature(app, "capture");
    requireData(app);
    const input = await c.body(MemorySaveInput);
    return checkSave(app, input);
  });
  r.post("/memory/save/proposals", async (c) => {
    requireFeature(app, "capture");
    requireData(app);
    const input = await c.body(MemorySaveProposalInput);
    const out = proposeSave(app, input);
    app.bus.emit("event", { type: "memory.changed" });
    return out;
  });
  r.get("/memory/audit", () => {
    requireFeature(app, "recall");
    requireData(app);
    return auditMemory(app);
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
    return { proposals: app.proposals.list({ status: status as ProposalView["status"], limit: Number(c.query("limit") ?? 100) }) };
  });
  r.post("/memory/proposals", async (c) => {
    requireFeature(app, "capture");
    const input = await c.body(ProposalInput);
    const out = app.proposals.propose(input, "model");
    app.bus.emit("event", { type: "memory.changed" });
    return out;
  });
  r.post("/memory/proposals/:id/:decision", (c) => {
    requireFeature(app, "capture");
    const d = c.params.decision;
    if (d !== "apply" && d !== "reject") throw new HttpError(400, "invalid_request", "decision must be apply or reject");
    const out = app.proposals.decide(c.params.id!, d);
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
      const item = app.inbox.decide(c.params.id!, body.decision, c.client!.id, body.until);
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
