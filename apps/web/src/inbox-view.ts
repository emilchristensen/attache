import type { AttentionItemView } from "@attache/contracts";
import { FAMILIES, inboxType, typeWord, type FamilyId } from "./inbox-types.ts";

/**
 * The Inbox list's rules, pure: the two orders, the frozen snapshot that holds new items back until the owner asks
 * for them, pages of twenty, the type picker's options and Group by type's previews.
 */

export type ViewItem = Pick<AttentionItemView, "id" | "key" | "kind" | "sourceKind" | "priority" | "dueAt" | "firstSeenAt">;

/** "priority": the service's priority, then the earliest due instant (undated last), then the item key. "newest": first seen, newest first. */
export type InboxOrder = "priority" | "newest";

/** The rows a page shows, and how many more Load more adds. */
export const PAGE_SIZE = 20;
/** The rows each family shows under Group by type before Show all. */
export const PREVIEWS = 3;
/** The type picker's "every type" option. */
export const ALL_TYPES = "all";

const dueInstant = (dueAt: string | null) => (dueAt ? Date.parse(dueAt) : Number.POSITIVE_INFINITY);
const byKey = (a: ViewItem, b: ViewItem) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

const COMPARE: Readonly<Record<InboxOrder, (a: ViewItem, b: ViewItem) => number>> = {
  priority: (a, b) => b.priority - a.priority || dueInstant(a.dueAt) - dueInstant(b.dueAt) || byKey(a, b),
  newest: (a, b) => Date.parse(b.firstSeenAt) - Date.parse(a.firstSeenAt) || byKey(a, b),
};

export function ordered<T extends ViewItem>(items: readonly T[], order: InboxOrder): T[] {
  return [...items].sort(COMPARE[order]);
}

export interface FrozenList<T> {
  /** The rows shown, in the snapshot's order, each with its latest data. */
  rows: T[];
  /** Items the snapshot does not hold yet, in the view's order; Show new items adds them. */
  arrivals: T[];
  /** Snapshot ids no longer in the live list (decided here or elsewhere). */
  gone: string[];
}

/** The live list seen through a snapshot of ids, so nothing moves until the owner asks for new items. */
export function frozenList<T extends ViewItem>(snapshot: readonly string[], live: readonly T[], order: InboxOrder): FrozenList<T> {
  const byId = new Map(live.map((i) => [i.id, i]));
  const held = new Set(snapshot);
  return {
    rows: snapshot.flatMap((id) => byId.get(id) ?? []),
    arrivals: ordered(
      live.filter((i) => !held.has(i.id)),
      order,
    ),
    gone: snapshot.filter((id) => !byId.has(id)),
  };
}

export interface TypeOption {
  id: string;
  label: string;
  count: number;
}

const FAMILY_RANK = new Map(FAMILIES.map((f, n) => [f.id, n]));

/** All types with its count, then each type present (and the chosen one, even at zero), in family order. */
export function typeOptions(items: readonly ViewItem[], chosen: string = ALL_TYPES): TypeOption[] {
  const types = new Map<string, { label: string; family: FamilyId; count: number; first: number }>();
  items.forEach((item, n) => {
    const t = inboxType(item);
    const known = types.get(t.id);
    types.set(t.id, known ? { ...known, count: known.count + 1 } : { label: t.word, family: t.family, count: 1, first: n });
  });
  const listed = [...types.entries()].sort(([, a], [, b]) => FAMILY_RANK.get(a.family)! - FAMILY_RANK.get(b.family)! || a.first - b.first).map(([id, t]) => ({ id, label: t.label, count: t.count }));
  const missing = chosen !== ALL_TYPES && !types.has(chosen) ? [{ id: chosen, label: typeWord(chosen), count: 0 }] : [];
  return [{ id: ALL_TYPES, label: "All types", count: items.length }, ...listed, ...missing];
}

export function withType<T extends ViewItem>(items: readonly T[], typeId: string): T[] {
  return typeId === ALL_TYPES ? [...items] : items.filter((i) => inboxType(i).id === typeId);
}

/** "1–20 of 34" while Load more has more to add, "All 34" when every row shows. */
export function pageLabel(shown: number, total: number): string {
  return shown >= total ? `All ${total}` : `1–${shown} of ${total}`;
}

export interface FamilyGroup<T> {
  family: FamilyId;
  label: string;
  /** The rows to show: the first three, or all of them after Show all. */
  rows: T[];
  total: number;
  /** How many more rows Show all reveals. */
  hidden: number;
}

/** Group by type: one group per family present, in family order, each keeping the list's order. */
export function groupRows<T extends ViewItem>(rows: readonly T[], expanded: ReadonlySet<FamilyId>): Array<FamilyGroup<T>> {
  return FAMILIES.flatMap(({ id, label }) => {
    const all = rows.filter((r) => inboxType(r).family === id);
    if (!all.length) return [];
    const shown = expanded.has(id) ? all : all.slice(0, PREVIEWS);
    return [{ family: id, label, rows: shown, total: all.length, hidden: all.length - shown.length }];
  });
}
