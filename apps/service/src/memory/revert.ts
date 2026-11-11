import { HttpError } from "../http/router.ts";
import { parseStateEntries } from "./markdown.ts";
import { isProtected } from "./policy.ts";
import { noteHash, type MemoryChange, type MemoryStore } from "./store.ts";

export type RevertCheck = { allowed: true; reason: null } | { allowed: false; reason: string };

const ALLOWED: RevertCheck = { allowed: true, reason: null };
const refuse = (reason: string): RevertCheck => ({ allowed: false, reason });

/** Changes that write the Brain, as opposed to Proposals waiting for a decision. */
export function isBrainChange(c: MemoryChange): boolean {
  return c.status === "applied" && c.change !== "proposal";
}

const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/**
 * Whether one click can undo a change, and in plain words why not. A change can
 * be undone only while it is still the last word on what it changed: a later
 * change, or an edit made outside Jarvis, means undoing it would throw that away.
 */
export function checkRevert(store: MemoryStore, change: MemoryChange): RevertCheck {
  if (!isBrainChange(change)) return refuse("Only applied changes can be reverted.");
  if (isProtected(change.docRelPath)) return refuse("This is your identity record. Change it in Settings.");
  const later = store.listChanges({ relPath: change.docRelPath, after: change.seq, limit: 500 }).filter(isBrainChange);
  if (later.some((c) => c.reverts === change.id)) return refuse("Already reverted.");
  // A later change that was itself reverted cancels out with its revert, so undo works like a stack.
  const laterIds = new Set(later.map((c) => c.id));
  const undone = new Set(later.flatMap((c) => (c.reverts && laterIds.has(c.reverts) ? [c.reverts] : [])));
  const standing = later.filter((c) => !undone.has(c.id) && !(c.reverts && undone.has(c.reverts)));
  switch (change.change) {
    case "correct":
      return checkFact(store, change, standing);
    case "create":
      return checkCreated(store, change, standing, later[0] ?? change);
    case "delete":
      return checkRemoved(store, change, standing);
    case "append":
      return change.subject === "Notes" ? refuse("Edits to a note's text cannot be reverted here.") : refuse("Events stay in History, which only grows. Save a new event to set the record straight.");
    default:
      return refuse("This kind of change cannot be reverted.");
  }
}

function checkFact(store: MemoryStore, change: MemoryChange, later: MemoryChange[]): RevertCheck {
  const subject = change.subject!.toLowerCase();
  if (later.some((c) => c.change === "delete")) return refuse("The note was removed after this change.");
  if (later.some((c) => c.change === "correct" && c.subject?.toLowerCase() === subject)) return refuse(`A later change overwrote “${change.subject}”. Revert that change first.`);
  if (!store.exists(change.docRelPath)) return refuse("The note no longer exists.");
  const current = parseStateEntries(store.read(change.docRelPath)).find((e) => e.subject.toLowerCase() === subject);
  const unchanged = change.afterValue === null ? !current : current !== undefined && sameText(current.value, change.afterValue) && (current.review ?? null) === change.afterReview;
  return unchanged ? ALLOWED : refuse(`“${change.subject}” was edited outside Jarvis after this change.`);
}

function checkCreated(store: MemoryStore, change: MemoryChange, later: MemoryChange[], last: MemoryChange): RevertCheck {
  if (later.some((c) => c.change === "delete")) return refuse("The note was removed after this change.");
  if (!store.exists(change.docRelPath)) return refuse("The note no longer exists.");
  // Events and facts written by the same save belong to the creation; anything else would be lost.
  if (later.some((c) => !change.batchId || c.batchId !== change.batchId)) return refuse("The note changed after it was created. Revert the later changes first.");
  if (!last.docHash) return refuse("This change is older than one-click revert.");
  if (noteHash(store.read(change.docRelPath)) !== last.docHash) return refuse("The note was edited outside Jarvis after it was created.");
  return ALLOWED;
}

function checkRemoved(store: MemoryStore, change: MemoryChange, later: MemoryChange[]): RevertCheck {
  if (!change.beforeValue) return refuse("Jarvis kept no copy of this note.");
  if (later.length || store.exists(change.docRelPath)) return refuse("Another note now has this file name.");
  return ALLOWED;
}

/** Why a change is undone, as History and the restored fact's source will say. */
export interface RevertReason {
  reason: (change: MemoryChange) => string;
  label: string;
}

const DASHBOARD_REVERT: RevertReason = {
  reason: (change) => `reverted the change of ${change.createdAt.slice(0, 16).replace("T", " ")} UTC in the Dashboard`,
  label: "Revert in the Dashboard",
};

/**
 * Undo one change as the owner's own Dashboard action: a fact gets its previous
 * value and Review date back as a correction (so History shows both steps), a created note is
 * removed from the Brain and search, and a removed note comes back as it was.
 * The undo is recorded as a change of its own.
 */
export function revertChange(store: MemoryStore, id: string, why: RevertReason = DASHBOARD_REVERT): MemoryChange {
  const change = store.getChange(id);
  if (!change || !isBrainChange(change)) throw new HttpError(404, "not_found", "That change is not in the change log. Reload the list.");
  const check = checkRevert(store, change);
  if (!check.allowed) throw new HttpError(409, "not_revertible", check.reason);
  const reason = why.reason(change);
  const meta = { reverts: change.id };
  switch (change.change) {
    case "correct":
      if (change.beforeValue === null) return store.removeFact(change.docRelPath, { subject: change.subject!, reason }, "user", meta);
      return store.correct(change.docRelPath, { subject: change.subject!, value: change.beforeValue, review: change.beforeReview, reason, source: { kind: "user", ref: "dashboard", label: why.label, observedAt: new Date().toISOString() } }, "user", {}, meta);
    case "create":
      return store.deleteMemory(change.docRelPath, { reason }, "user", meta);
    case "delete":
      return store.restoreMemory(change.docRelPath, change.beforeValue!, { reason }, "user", meta);
    default:
      throw new HttpError(409, "not_revertible", "This kind of change cannot be reverted.");
  }
}
