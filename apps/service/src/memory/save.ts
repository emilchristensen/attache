import { join } from "node:path";
import type { MemorySaveInput, MemorySaveResult } from "@jarvis/contracts";
import type { App } from "../app.ts";
import { nowIso } from "../core/db.ts";
import { integrationFor } from "../agents/integrations.ts";
import { slugify } from "./markdown.ts";
import { isProtected, normalizeRel } from "./policy.ts";
import { HttpError } from "../http/router.ts";
import { formatSource, type SourceRef } from "./store.ts";

/**
 * Apply what the user asked a coding agent to save. Every item is checked
 * before the first write, so a bad path or a duplicate note rejects the whole
 * save instead of leaving half of it behind. Writes run as the user: saving is
 * the user's explicit request, made through their own paired CLI.
 */
export function saveToMemory(app: App, input: MemorySaveInput, clientId: string | null): MemorySaveResult {
  const root = app.memory.dataRoot;
  if (!root) throw new HttpError(409, "needs_data_folder", "Choose a data folder first.");
  const plan = input.items.map((item) => (item.action === "create" ? checkCreate(app, item) : checkUpdate(app, item)));
  const creating = new Set<string>();
  for (const step of plan) {
    if (step.action !== "create") continue;
    const key = `${step.item.type}:${slugify(step.item.title)}`;
    if (creating.has(key)) throw new HttpError(400, "invalid_request", `The save creates the ${step.item.type} note "${step.item.title}" twice. Merge the two items.`);
    creating.add(key);
  }
  const source = originSource(app, input.origin);
  const label = source ? formatSource(source) : null;
  const withSource = (text: string) => (label ? `${text} (source: ${label})` : text);
  const saved: MemorySaveResult["saved"] = [];
  for (const step of plan) {
    if (step.action === "create") {
      const { item } = step;
      const { relPath } = app.memory.createMemory(
        { type: item.type, title: item.title, state: item.facts, ...(item.notes?.trim() ? { notes: item.notes } : {}), sources: source ? [source] : [], provenance: "agent-saved", ...(item.tags?.length ? { tags: item.tags } : {}) },
        "user",
      );
      for (const e of item.events ?? []) app.memory.appendEvent(relPath, withSource(e), "user");
      saved.push({ action: "created", relPath, absPath: join(root, relPath), title: item.title, facts: item.facts.length, events: item.events?.length ?? 0 });
    } else {
      const { item, relPath, title } = step;
      for (const f of item.facts ?? []) app.memory.correct(relPath, { subject: f.subject, value: f.value, reason: f.reason, ...(source ? { source } : {}) }, "user");
      for (const e of item.events ?? []) app.memory.appendEvent(relPath, withSource(e), "user");
      saved.push({ action: "updated", relPath, absPath: join(root, relPath), title, facts: item.facts?.length ?? 0, events: item.events?.length ?? 0 });
    }
  }
  app.db.prepare("insert into audit (at, actor, event, data) values (?,?,?,?)").run(nowIso(), clientId ?? "user", "memory_saved", JSON.stringify({ origin: input.origin ?? null, saved: saved.map((s) => ({ action: s.action, relPath: s.relPath })) }));
  return { saved };
}

type CreateItem = Extract<MemorySaveInput["items"][number], { action: "create" }>;
type UpdateItem = Extract<MemorySaveInput["items"][number], { action: "update" }>;

function uniqueSubjects(facts: Array<{ subject: string }>, where: string) {
  const seen = new Set<string>();
  for (const f of facts) {
    const key = f.subject.toLowerCase();
    if (seen.has(key)) throw new HttpError(400, "invalid_request", `${where} sets "${f.subject}" twice. Give each subject one current value.`);
    seen.add(key);
  }
}

/** A new note must not duplicate one Jarvis already has: the same type and title is an update, not a second note. */
function checkCreate(app: App, item: CreateItem): { action: "create"; item: CreateItem } {
  uniqueSubjects(item.facts, `"${item.title}"`);
  const slug = slugify(item.title);
  const twin = app.memory.listDocuments({ area: "memory", root: "data", docType: item.type, limit: 2000 }).find((d) => slugify(d.title) === slug);
  if (twin) throw new HttpError(409, "already_exists", `A ${item.type} note "${twin.title}" already exists at ${twin.relPath}. Update it instead of creating another.`, { relPath: twin.relPath });
  return { action: "create", item };
}

function checkUpdate(app: App, item: UpdateItem): { action: "update"; item: UpdateItem; relPath: string; title: string } {
  const relPath = normalizeRel(item.path.replace(/^\.\//, ""));
  if (!relPath.startsWith("memory/") || !relPath.endsWith(".md")) throw new HttpError(400, "not_memory", `${item.path} is not a memory note. Only notes under memory/ can be updated.`);
  if (isProtected(relPath)) throw new HttpError(403, "protected", `${relPath} is your identity record; change it in Jarvis Settings.`);
  if (!app.memory.exists(relPath)) throw new HttpError(404, "not_found", `${relPath} does not exist. Search for the note, or create a new one.`);
  if (!item.facts?.length && !item.events?.length) throw new HttpError(400, "invalid_request", `The update to ${relPath} has no facts or events.`);
  uniqueSubjects(item.facts ?? [], relPath);
  return { action: "update", item, relPath, title: app.memory.describe(relPath).title };
}

/** Cite the session the items came from: its archived transcript when Jarvis has one, otherwise the agent and session id. */
function originSource(app: App, origin: MemorySaveInput["origin"]): SourceRef | null {
  if (!origin) return null;
  const agentLabel = integrationFor(origin.agent)?.label ?? origin.agent;
  const row = origin.sessionId ? (app.db.prepare("select rel_path from agent_sessions where agent = ? and session_id = ?").get(origin.agent, origin.sessionId) as { rel_path: string } | undefined) : undefined;
  const folder = origin.cwd?.split("/").filter(Boolean).at(-1);
  return {
    kind: "agent-session",
    ref: row?.rel_path ?? `${origin.agent}/${origin.sessionId || "unknown-session"}`,
    observedAt: nowIso(),
    label: `${agentLabel} session${folder ? ` in ${folder}` : ""}`,
  };
}
