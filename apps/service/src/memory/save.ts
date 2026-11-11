import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { MemorySaveCheckResult, MemorySaveInput, MemorySaveProposalInput, MemorySaveProposalResult, MemorySaveResult } from "@jarvis/contracts";
import type { App } from "../app.ts";
import { nowIso, tx } from "../core/db.ts";
import { harnessLabel } from "../agents/integrations.ts";
import { HttpError } from "../http/router.ts";
import { proposeItems } from "./proposals.ts";
import { checkItems, writeItem } from "./save-items.ts";
import type { ChangeMeta, SourceRef } from "./store.ts";

/**
 * Apply what the user asked a coding agent to save. Every item is checked
 * before the first write, so a bad path or a duplicate note rejects the whole
 * save instead of leaving half of it behind. Writes run as the user: saving is
 * the user's explicit request, made through their own paired CLI.
 */
export function saveToMemory(app: App, input: MemorySaveInput, clientId: string | null): MemorySaveResult {
  const root = app.memory.dataRoot;
  if (!root) throw new HttpError(409, "needs_data_folder", "Choose a data folder first.");
  const plan = checkItems(app.memory, input.items);
  const source = originSource(app, input.origin);
  // One batch id for the whole save, with the Harness and session it came from, so recent saves can show and undo it as one.
  const meta: ChangeMeta = { harness: input.origin?.agent ?? null, sessionId: input.origin?.sessionId || null, batchId: randomUUID() };
  const saved: MemorySaveResult["saved"] = plan.map((step) => {
    const written = writeItem(app.memory, step, source, { actor: "user", provenance: "agent-saved" }, meta);
    return { ...written, absPath: join(root, written.relPath) };
  });
  app.db.prepare("insert into audit (at, actor, event, data) values (?,?,?,?)").run(nowIso(), clientId ?? "user", "memory_saved", JSON.stringify({ origin: input.origin ?? null, saved: saved.map((s) => ({ action: s.action, relPath: s.relPath })) }));
  return { saved };
}

/**
 * Check a save against the Brain without writing anything, so a Harness can
 * show the owner what it would change, and an invalid item is refused before
 * the owner is asked.
 */
export function checkSave(app: App, items: MemorySaveInput["items"]): MemorySaveCheckResult {
  if (!app.memory.dataRoot) throw new HttpError(409, "needs_data_folder", "Choose a data folder first.");
  return {
    items: checkItems(app.memory, items).map((step) => (step.action === "create" ? { action: "create", title: step.item.title, relPath: null } : { action: "update", title: step.title, relPath: step.relPath })),
  };
}

/**
 * Store a save the owner could not confirm as one Proposal per item, citing
 * the Harness session, so it is neither lost nor written unseen. The items are
 * checked as one save: every Proposal is recorded, or none.
 */
export function proposeSave(app: App, input: MemorySaveProposalInput): MemorySaveProposalResult {
  const source = originSource(app, input.origin);
  const proposedBy = input.origin ? harnessLabel(input.origin.agent) : "model";
  return { proposals: tx(app.db, () => proposeItems(app.memory, input.items, { reason: input.reason, source, origin: input.origin ?? null, proposedBy })) };
}

/** Cite the session the items came from: its archived transcript when Jarvis has one, otherwise the agent and session id. */
export function originSource(app: App, origin: MemorySaveInput["origin"]): SourceRef | null {
  if (!origin) return null;
  const agentLabel = harnessLabel(origin.agent);
  const row = origin.sessionId ? (app.db.prepare("select rel_path from agent_sessions where agent = ? and session_id = ?").get(origin.agent, origin.sessionId) as { rel_path: string } | undefined) : undefined;
  const folder = origin.cwd?.split("/").filter(Boolean).at(-1);
  return {
    kind: "agent-session",
    ref: row?.rel_path ?? `${origin.agent}/${origin.sessionId || "unknown-session"}`,
    observedAt: nowIso(),
    label: `${agentLabel} session${folder ? ` in ${folder}` : ""}`,
  };
}
