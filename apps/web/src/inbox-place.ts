import { useCallback, useRef, useState } from "react";
import { ALL_TYPES, PAGE_SIZE } from "./inbox-view.ts";
import { FAMILIES, type FamilyId } from "./inbox-types.ts";

/**
 * The Inbox view the owner chose and their place in it (the type, the view, how many rows Load more has shown, the
 * families Show all opened, the open row and, across a visit to a Draft, the row's place on screen), kept for this tab in sessionStorage so a visit to a Draft and back finds it as it was.
 */

export type InboxViewId = "priority" | "newest" | "grouped" | "hidden";

export const INBOX_VIEWS: ReadonlyArray<{ id: InboxViewId; label: string }> = [
  { id: "priority", label: "Priority order" },
  { id: "newest", label: "Newest first" },
  { id: "grouped", label: "Group by type" },
  { id: "hidden", label: "Hidden" },
];

export interface InboxPlace {
  view: InboxViewId;
  type: string;
  shown: number;
  /** Families Show all opened under Group by type. */
  expanded: FamilyId[];
  openId: string | null;
  /** The row View draft left from and where it stood in Home's scroller (`views/inbox-return.ts`); null once Home is back. */
  anchor: InboxAnchor | null;
}

/** A row and how far below the top of Home's scroller it stood, in pixels. */
export interface InboxAnchor {
  id: string;
  top: number;
}

function parseAnchor(a: unknown): InboxAnchor | null {
  if (!a || typeof a !== "object") return null;
  const { id, top } = a as Partial<InboxAnchor>;
  return typeof id === "string" && typeof top === "number" && Number.isFinite(top) ? { id, top } : null;
}

const STORAGE_KEY = "attache.inbox.place";
export const DEFAULT_PLACE: InboxPlace = { view: "priority", type: ALL_TYPES, shown: PAGE_SIZE, expanded: [], openId: null, anchor: null };

/** A stored place, or the default when it is missing, unreadable or from an older shape. */
export function parsePlace(raw: string | null): InboxPlace {
  try {
    const p = JSON.parse(raw ?? "null") as Partial<InboxPlace> | null;
    if (!p || typeof p !== "object") return DEFAULT_PLACE;
    return {
      view: INBOX_VIEWS.some((v) => v.id === p.view) ? p.view! : DEFAULT_PLACE.view,
      type: typeof p.type === "string" && p.type ? p.type : ALL_TYPES,
      shown: Number.isInteger(p.shown) && p.shown! >= PAGE_SIZE ? p.shown! : PAGE_SIZE,
      expanded: Array.isArray(p.expanded) ? FAMILIES.map((f) => f.id).filter((id) => p.expanded!.includes(id)) : [],
      openId: typeof p.openId === "string" ? p.openId : null,
      anchor: parseAnchor(p.anchor),
    };
  } catch {
    return DEFAULT_PLACE;
  }
}

function load(): InboxPlace {
  try {
    return parsePlace(window.sessionStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_PLACE;
  }
}

/**
 * The place and a way to change part of it. A change is stored at once, not when React next renders: View draft
 * changes the place and leaves Home in the same moment, and an update queued for a screen that is leaving never runs.
 */
export function useInboxPlace(): [InboxPlace, (change: Partial<InboxPlace>) => void] {
  const [place, setPlace] = useState(load);
  const current = useRef(place);
  const update = useCallback((change: Partial<InboxPlace>) => {
    const next = { ...current.current, ...change };
    current.current = next;
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Blocked storage: the place lasts until the page closes.
    }
    setPlace(next);
  }, []);
  return [place, update];
}
