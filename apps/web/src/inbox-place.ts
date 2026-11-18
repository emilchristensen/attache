import { useCallback, useState } from "react";
import { ALL_TYPES, PAGE_SIZE } from "./inbox-view.ts";

/**
 * The Inbox view the owner chose and their place in it (the type, the view, how many rows Load more has shown and
 * the open row), kept for this tab in sessionStorage so a visit to a Draft and back finds it as it was.
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
  openId: string | null;
}

const STORAGE_KEY = "attache.inbox.place";
export const DEFAULT_PLACE: InboxPlace = { view: "priority", type: ALL_TYPES, shown: PAGE_SIZE, openId: null };

/** A stored place, or the default when it is missing, unreadable or from an older shape. */
export function parsePlace(raw: string | null): InboxPlace {
  try {
    const p = JSON.parse(raw ?? "null") as Partial<InboxPlace> | null;
    if (!p || typeof p !== "object") return DEFAULT_PLACE;
    return {
      view: INBOX_VIEWS.some((v) => v.id === p.view) ? p.view! : DEFAULT_PLACE.view,
      type: typeof p.type === "string" && p.type ? p.type : ALL_TYPES,
      shown: Number.isInteger(p.shown) && p.shown! >= PAGE_SIZE ? p.shown! : PAGE_SIZE,
      openId: typeof p.openId === "string" ? p.openId : null,
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

export function useInboxPlace(): [InboxPlace, (change: Partial<InboxPlace>) => void] {
  const [place, setPlace] = useState(load);
  const update = useCallback((change: Partial<InboxPlace>) => {
    setPlace((prev) => {
      const next = { ...prev, ...change };
      try {
        window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Blocked storage: the place lasts until the page closes.
      }
      return next;
    });
  }, []);
  return [place, update];
}
