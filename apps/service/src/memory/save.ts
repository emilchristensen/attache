import { join } from "node:path";
import type { MemorySaveInput, MemorySaveResult } from "@jarvis/contracts";
import type { App } from "../app.ts";
import { nowIso } from "../core/db.ts";
import { integrationFor } from "../agents/integrations.ts";
import { HttpError } from "../http/router.ts";
import { checkItems, writeItem } from "./save-items.ts";
import type { SourceRef } from "./store.ts";

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
  const saved: MemorySaveResult["saved"] = plan.map((step) => {
    const written = writeItem(app.memory, step, source, { actor: "user", provenance: "agent-saved" });
    return { ...written, absPath: join(root, written.relPath) };
  });
  app.db.prepare("insert into audit (at, actor, event, data) values (?,?,?,?)").run(nowIso(), clientId ?? "user", "memory_saved", JSON.stringify({ origin: input.origin ?? null, saved: saved.map((s) => ({ action: s.action, relPath: s.relPath })) }));
  return { saved };
}

/** Cite the session the items came from: its archived transcript when Jarvis has one, otherwise the agent and session id. */
export function originSource(app: App, origin: MemorySaveInput["origin"]): SourceRef | null {
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
