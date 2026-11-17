import { UNREVIEWED_DAYS, type RecentChangeView } from "@attache/contracts";
import type { Db } from "../core/db.ts";
import { integrationFor } from "../agents/integrations.ts";
import { fileTitle, parseMarkdown } from "./markdown.ts";
import { CONSOLIDATION_ACTOR } from "./policy.ts";
import { checkRevert, isBrainChange } from "./revert.ts";
import type { MemoryChange, MemoryStore } from "./store.ts";

/** The most changes one list reads from the change log. */
const SCAN = 500;

/**
 * The newest changes to the Brain, each with where it came from and whether one
 * click can undo it. Proposals are left out: an applied Proposal shows as the
 * change it made.
 */
export function recentChanges(db: Db, store: MemoryStore, limit: number): RecentChangeView[] {
  const changes = store.listChanges({ status: "applied", limit: SCAN }).filter(isBrainChange).slice(0, limit);
  return toViews(db, store, changes);
}

/**
 * Every change written without the owner reviewing it (an auto-accepted save
 * or a Consolidation write) in the last {@link UNREVIEWED_DAYS} days before
 * `now`, newest first, however many there are: the window bounds the list. A revert is reviewed by definition, so only the change
 * it undid shows, marked reverted.
 */
export function unreviewedChanges(db: Db, store: MemoryStore, now: Date): RecentChangeView[] {
  const since = new Date(now.getTime() - UNREVIEWED_DAYS * 86_400_000).toISOString();
  return toViews(db, store, store.listChanges({ status: "applied", autoAccepted: true, since, limit: "all" }).filter(isBrainChange));
}

function toViews(db: Db, store: MemoryStore, changes: MemoryChange[]): RecentChangeView[] {
  const revertedBy = db.prepare("select id from memory_changes where reverts = ? and status = 'applied'");
  const titles = noteTitles(db, store);
  const sources = sourcesOf(db);
  return changes.map((c) => ({
    id: c.id,
    relPath: c.docRelPath,
    title: titles(c),
    kind: c.change as RecentChangeView["kind"],
    subject: c.subject,
    ...values(c),
    reason: c.reason,
    source: sources(c),
    at: c.createdAt,
    revertOf: c.reverts,
    revertedBy: (revertedBy.get(c.id) as { id: string } | undefined)?.id ?? null,
    revert: checkRevert(store, c),
  }));
}

function values(c: MemoryChange): Pick<RecentChangeView, "oldValue" | "newValue" | "oldReview" | "newReview"> {
  switch (c.change) {
    case "create":
      return { oldValue: null, newValue: c.afterValue, oldReview: null, newReview: null };
    case "delete":
      return { oldValue: c.beforeValue ? parseMarkdown(c.beforeValue, c.docRelPath).title : null, newValue: null, oldReview: null, newReview: null };
    default:
      return { oldValue: c.beforeValue, newValue: c.afterValue, oldReview: c.beforeReview, newReview: c.afterReview };
  }
}

/** Where each change came from: the Harness and session of a save, what Consolidation read, or who else made it. */
function sourcesOf(db: Db): (c: MemoryChange) => RecentChangeView["source"] {
  const indexedTitle = db.prepare("select title from documents where root = 'data' and rel_path = ?");
  const captureOf = (relPath: string) => ({ relPath, title: (indexedTitle.get(relPath) as { title: string } | undefined)?.title ?? fileTitle(relPath) });
  return (c) => {
    const harnessLabel = c.harness ? (integrationFor(c.harness)?.label ?? c.harness) : null;
    const session = harnessLabel ? `${harnessLabel}${c.sessionId ? `, session ${c.sessionId}` : ""}` : null;
    const base = { harness: c.harness, harnessLabel, sessionId: c.sessionId, autoAccepted: c.autoAccepted };
    if (c.actor === CONSOLIDATION_ACTOR) {
      if (c.capture) {
        const meeting = captureOf(c.capture);
        return { ...base, label: `Consolidation of meeting “${meeting.title}”`, consolidation: { from: "meeting", capture: meeting } };
      }
      const label = harnessLabel ? `Consolidation of ${harnessLabel} session${c.sessionId ? ` ${c.sessionId}` : ""}` : "Consolidation";
      return { ...base, label, consolidation: { from: "session", capture: null } };
    }
    const label = session ?? (c.reverts ? "Revert in the Dashboard" : c.actor === "service" ? "A Proposal you approved" : (c.source ?? "You"));
    return { ...base, label, consolidation: null };
  };
}

/** A note's title from the index, or for a note that is gone, from the change that created or removed it. */
function noteTitles(db: Db, store: MemoryStore): (c: MemoryChange) => string {
  const indexed = new Map((db.prepare("select rel_path, title from documents where root = 'data' and area = 'memory'").all() as Array<{ rel_path: string; title: string }>).map((r) => [r.rel_path, r.title]));
  return (c) => {
    const known = indexed.get(c.docRelPath);
    if (known) return known;
    if (c.change === "delete" && c.beforeValue) return parseMarkdown(c.beforeValue, c.docRelPath).title;
    const created = store.listChanges({ relPath: c.docRelPath, limit: SCAN }).find((x) => x.change === "create" && x.afterValue);
    return created?.afterValue ?? fileTitle(c.docRelPath);
  };
}
