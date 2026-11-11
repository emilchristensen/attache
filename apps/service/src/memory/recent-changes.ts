import type { RecentChangeView } from "@jarvis/contracts";
import type { Db } from "../core/db.ts";
import { integrationFor } from "../agents/integrations.ts";
import { parseMarkdown } from "./markdown.ts";
import { checkRevert, isBrainChange } from "./revert.ts";
import type { MemoryChange, MemoryStore } from "./store.ts";

/**
 * The newest changes to the Brain, each with where it came from and whether one
 * click can undo it. Proposals are left out: an applied Proposal shows as the
 * change it made.
 */
export function recentChanges(db: Db, store: MemoryStore, limit: number): RecentChangeView[] {
  const changes = store
    .listChanges({ status: "applied", limit: 500 })
    .filter(isBrainChange)
    .slice(0, limit);
  const revertedBy = db.prepare("select id from memory_changes where reverts = ? and status = 'applied'");
  const titles = noteTitles(db, store);
  return changes.map((c) => ({
    id: c.id,
    relPath: c.docRelPath,
    title: titles(c),
    kind: c.change as RecentChangeView["kind"],
    subject: c.subject,
    ...values(c),
    source: sourceOf(c),
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

function sourceOf(c: MemoryChange): RecentChangeView["source"] {
  const harnessLabel = c.harness ? (integrationFor(c.harness)?.label ?? c.harness) : null;
  const label = harnessLabel ? `${harnessLabel}${c.sessionId ? `, session ${c.sessionId}` : ""}` : c.reverts ? "Revert in the Dashboard" : c.actor === "service" ? "A Proposal you approved" : (c.source ?? "You");
  return { harness: c.harness, harnessLabel, sessionId: c.sessionId, label, autoAccepted: c.autoAccepted };
}

/** A note's title from the index, or for a note that is gone, from the change that created or removed it. */
function noteTitles(db: Db, store: MemoryStore): (c: MemoryChange) => string {
  const indexed = new Map((db.prepare("select rel_path, title from documents where root = 'data' and area = 'memory'").all() as Array<{ rel_path: string; title: string }>).map((r) => [r.rel_path, r.title]));
  return (c) => {
    const known = indexed.get(c.docRelPath);
    if (known) return known;
    if (c.change === "delete" && c.beforeValue) return parseMarkdown(c.beforeValue, c.docRelPath).title;
    const created = store.listChanges({ relPath: c.docRelPath, limit: 500 }).find((x) => x.change === "create" && x.afterValue);
    return created?.afterValue ?? c.docRelPath.split("/").at(-1)!.replace(/\.md$/, "");
  };
}
