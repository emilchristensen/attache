import { useState, type ReactNode } from "react";

/** How many entries a long list of changes shows until the owner asks for all of them. */
export const COLLAPSED = 5;

/**
 * The first {@link COLLAPSED} of `items`, and a button that shows all of them
 * or fewer again; no button when every item already shows.
 */
export function useCollapsedList<T>(items: readonly T[]): { shown: readonly T[]; toggle: ReactNode } {
  const [expanded, setExpanded] = useState(false);
  if (items.length <= COLLAPSED) return { shown: items, toggle: null };
  return {
    shown: expanded ? items : items.slice(0, COLLAPSED),
    toggle: (
      <button className="ghost small collapse-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? "Show fewer" : `Show all ${items.length}`}
      </button>
    ),
  };
}
