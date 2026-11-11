import { checkRevert, isBrainChange, revertChange } from "./revert.ts";
import type { MemoryChange, MemoryStore } from "./store.ts";

export interface UndoOutcome {
  /** Changes undone now. */
  undone: string[];
  /** Changes that stay, each with why: events only grow, or something changed the note since. */
  kept: Array<{ change: string; path: string; reason: string }>;
}

function alreadyReverted(store: MemoryStore, change: MemoryChange): boolean {
  return store.listChanges({ relPath: change.docRelPath, after: change.seq, limit: 500 }).some((c) => c.reverts === change.id);
}

/**
 * Undo what approving a Proposal wrote on this Machine, as far as one-click
 * revert can: a created note is removed, corrected facts get their previous
 * value back. Events stay, because History only grows. Running it again
 * changes nothing.
 */
export function undoApproval(store: MemoryStore, batch: string, why: string): UndoOutcome {
  const changes = store.changesInBatch(batch).filter(isBrainChange);
  const created = changes.find((c) => c.change === "create");
  const targets = created ? [created] : changes;
  const outcome: UndoOutcome = { undone: [], kept: [] };
  const reason = { reason: () => `undone: ${why}`, label: "A later rejection of the Proposal" };
  for (const change of targets) {
    if (alreadyReverted(store, change)) continue;
    const check = checkRevert(store, change);
    if (!check.allowed) {
      outcome.kept.push({ change: change.id, path: change.docRelPath, reason: check.reason });
      continue;
    }
    revertChange(store, change.id, reason);
    outcome.undone.push(change.id);
  }
  return outcome;
}
