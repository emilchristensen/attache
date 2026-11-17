import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { MemorySaveCheckResult, MemorySaveInput, MemorySaveProposalInput, MemorySaveProposalResult, MemorySaveResult } from "@attache/contracts";
import type { App } from "../app.ts";
import { nowIso } from "../core/db.ts";
import { harnessLabel } from "../agents/integrations.ts";
import { HttpError } from "../http/router.ts";
import { isProtected } from "./policy.ts";
import { checkItems, writeItem, type CheckedItem } from "./save-items.ts";
import type { ChangeMeta, SourceRef } from "./store.ts";

/**
 * Apply what the owner asked a Harness to save. Every item is checked
 * before the first write, so a bad path or a duplicate note rejects the whole
 * save instead of leaving half of it behind. Only a save the owner confirmed
 * in the Harness, or one auto-accept lets through, writes as the owner;
 * anything else is stored as Proposals for the owner to decide on.
 */
export function saveToMemory(app: App, input: MemorySaveInput, clientId: string | null): MemorySaveResult {
  const root = app.memory.dataRoot;
  if (!root) throw new HttpError(409, "needs_data_folder", "Choose a data folder first.");
  const plan = checkItems(app.memory, input.items);
  const autoAccepted = input.autoAccept === true;
  if (autoAccepted && !mayAutoAccept(app, input.origin, plan)) {
    const harness = input.origin ? harnessLabel(input.origin.agent) : "an unnamed Harness";
    throw new HttpError(409, "auto_accept_off", `Auto-accept is off for ${harness} on this Machine, so the owner must confirm this save. Nothing was written.`);
  }
  if (!autoAccepted && !input.confirmed) {
    const harness = input.origin ? harnessLabel(input.origin.agent) : "A Harness";
    return { saved: [], ...proposeSave(app, { items: input.items, ...(input.origin ? { origin: input.origin } : {}), reason: `${harness} asked to save this, but the owner has not confirmed it, so it waits for review.` }) };
  }
  const source = originSource(app, input.origin);
  // One batch id for the whole save, with the Harness and session it came from, so recent saves can show and undo it as one.
  const meta: ChangeMeta = { harness: input.origin?.agent ?? null, sessionId: input.origin?.sessionId || null, batchId: randomUUID(), autoAccepted };
  const saved: MemorySaveResult["saved"] = plan.map((step) => {
    const written = writeItem(app.memory, step, source, { actor: "user", provenance: "agent-saved" }, meta);
    return { ...written, absPath: join(root, written.relPath) };
  });
  app.db
    .prepare("insert into audit (at, actor, event, data) values (?,?,?,?)")
    .run(nowIso(), clientId ?? "user", "memory_saved", JSON.stringify({ origin: input.origin ?? null, autoAccepted, saved: saved.map((s) => ({ action: s.action, relPath: s.relPath })) }));
  return { saved, proposals: [] };
}

/**
 * Check a save against the Brain without writing anything, so a Harness can
 * show the owner what it would change, and an invalid item is refused before
 * the owner is asked. Says whether the origin's Harness may skip asking.
 */
export function checkSave(app: App, input: Pick<MemorySaveInput, "items" | "origin">): MemorySaveCheckResult {
  if (!app.memory.dataRoot) throw new HttpError(409, "needs_data_folder", "Choose a data folder first.");
  const plan = checkItems(app.memory, input.items);
  return {
    items: plan.map((step) => (step.action === "create" ? { action: "create", title: step.item.title, relPath: null } : { action: "update", title: step.title, relPath: step.relPath })),
    autoAccept: mayAutoAccept(app, input.origin, plan),
  };
}

/**
 * A save is written without asking only when the owner switched on auto-accept
 * for its Harness on this Machine, and never when it touches the identity
 * record (which a save cannot change at all; kept here so the rule stands on its own).
 */
function mayAutoAccept(app: App, origin: MemorySaveInput["origin"], plan: readonly CheckedItem[]): boolean {
  if (!origin || !app.autoAccept.isOn(origin.agent)) return false;
  return plan.every((step) => step.action === "create" || !isProtected(step.relPath));
}

/**
 * Store a save the owner could not confirm as one Proposal per item, citing
 * the Harness session, so it is neither lost nor written unseen. The items are
 * checked as one save: every Proposal is recorded, or none.
 */
export function proposeSave(app: App, input: MemorySaveProposalInput): MemorySaveProposalResult {
  const source = originSource(app, input.origin);
  const proposedBy = input.origin ? harnessLabel(input.origin.agent) : "model";
  return { proposals: app.proposals.proposeItems(input.items, { reason: input.reason, source, origin: input.origin ?? null, proposedBy }) };
}

/** Cite the session the items came from: its archived transcript when Attache has one, otherwise the agent and session id. */
export function originSource(app: App, origin: MemorySaveInput["origin"]): SourceRef | null {
  if (!origin) return null;
  const agentLabel = harnessLabel(origin.agent);
  const row = origin.sessionId ? (app.db.prepare("select rel_path from agent_sessions where agent = ? and session_id = ?").get(origin.agent, origin.sessionId) as { rel_path: string } | undefined) : undefined;
  // The Harness reports its folder in its own operating system's form, so either separator ends a name.
  const folder = origin.cwd?.split(/[\\/]/).filter(Boolean).at(-1);
  return {
    kind: "agent-session",
    ref: row?.rel_path ?? `${origin.agent}/${origin.sessionId || "unknown-session"}`,
    observedAt: app.clock.now().toISOString(),
    label: `${agentLabel} session${folder ? ` in ${folder}` : ""}`,
  };
}
