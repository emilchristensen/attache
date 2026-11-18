import { useCallback, useLayoutEffect, useRef, useState } from "react";

export interface TabItem<T extends string> {
  id: T;
  label: string;
}

interface TabsProps<T extends string> {
  /** What the tabs choose between, for screen readers. */
  label: string;
  tabs: ReadonlyArray<TabItem<T>>;
  selected: T;
  onSelect: (id: T) => void;
  /** The panel the tabs control; the panel names its tab with `tabId`. */
  panelId?: string;
  /** Without the line under the tabs, for a bar that sits inside a row. */
  plain?: boolean;
}

/** The id of a tab that controls a panel, for the panel's `aria-labelledby`. */
export function tabId(panelId: string, id: string): string {
  return `${panelId}-tab-${id}`;
}

/** How far an edge's arrow and fade reach, from `--tabs-edge` in the stylesheet. */
function edgeWidth(list: HTMLElement): number {
  return parseFloat(getComputedStyle(list).getPropertyValue("--tabs-edge")) || 0;
}

/** Which ends of a tab bar have tabs scrolled out of view. */
interface Hidden {
  before: boolean;
  after: boolean;
}

function hiddenTabs(list: HTMLElement): Hidden {
  const max = list.scrollWidth - list.clientWidth;
  return { before: list.scrollLeft > 1, after: list.scrollLeft < max - 1 };
}

/** Scrolls the bar, and only the bar, so the tab shows in full beside the edge fades. */
function bringIntoView(list: HTMLElement, tab: HTMLElement) {
  const edge = edgeWidth(list);
  const left = tab.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft;
  const right = left + tab.offsetWidth;
  if (left < list.scrollLeft + edge) list.scrollLeft = Math.max(0, left - edge);
  else if (right > list.scrollLeft + list.clientWidth - edge) list.scrollLeft = right - list.clientWidth + edge;
}

/** A chevron pointing back or forward. */
function Chevron({ forward }: { forward: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={forward ? "M4.5 2.5 8 6l-3.5 3.5" : "M7.5 2.5 4 6l3.5 3.5"} />
    </svg>
  );
}

/**
 * A row of tabs that never wraps. When the tabs are wider than their column,
 * the row scrolls sideways: the edges fade where tabs are out of view, arrows
 * there scroll by a page, and the selected or focused tab is kept in view.
 */
export function Tabs<T extends string>({ label, tabs, selected, onSelect, panelId, plain }: TabsProps<T>) {
  const listRef = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState<Hidden>({ before: false, after: false });
  const measure = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    const next = hiddenTabs(list);
    setHidden((prev) => (prev.before === next.before && prev.after === next.after ? prev : next));
  }, []);

  const showSelected = useCallback(() => {
    const list = listRef.current;
    const tab = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (list && tab) bringIntoView(list, tab);
    measure();
  }, [measure]);

  // A layout effect, like the first alignment below: widths are seeded in the same frame, before a font can swap in.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const bar = new ResizeObserver(measure);
    bar.observe(list);
    // A tab changes width when Inter replaces the fallback font after the first layout; the focused tab, or else the
    // selected one, must stay in view. Only a real width change counts, not a height change.
    const widths = new WeakMap<Element, number>();
    const tabWidths = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const width = entry.borderBoxSize[0]?.inlineSize ?? entry.contentRect.width;
        const before = widths.get(entry.target);
        widths.set(entry.target, width);
        if (before !== undefined && before !== width) changed = true;
      }
      if (!changed) return;
      const focused = list.querySelector<HTMLElement>('[role="tab"]:focus');
      if (focused) {
        bringIntoView(list, focused);
        measure();
      } else showSelected();
    });
    for (const tab of list.children) {
      // Seed with the width now, so a font swap before the observer's first report still counts as a change.
      widths.set(tab, tab.getBoundingClientRect().width);
      tabWidths.observe(tab);
    }
    list.addEventListener("scroll", measure, { passive: true });
    return () => {
      bar.disconnect();
      tabWidths.disconnect();
      list.removeEventListener("scroll", measure);
    };
  }, [measure, showSelected, tabs]);

  useLayoutEffect(showSelected, [selected, showSelected]);

  const page = (direction: 1 | -1) => {
    const list = listRef.current;
    if (!list) return;
    const edge = edgeWidth(list);
    list.scrollBy({ left: direction * Math.max(list.clientWidth - 2 * edge, edge), behavior: "smooth" });
  };

  return (
    <div className={`tabs-bar${plain ? " plain" : ""}`} data-hidden-before={hidden.before || undefined} data-hidden-after={hidden.after || undefined}>
      <div ref={listRef} className="tabs" role="tablist" aria-label={label}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={panelId ? tabId(panelId, t.id) : undefined}
            aria-controls={panelId}
            aria-selected={t.id === selected}
            onClick={() => onSelect(t.id)}
            onFocus={(e) => listRef.current && bringIntoView(listRef.current, e.currentTarget)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {/* Pointer shortcuts only: keyboard focus and touch reach every tab by themselves. */}
      <button type="button" className="tabs-scroll before" tabIndex={-1} aria-hidden hidden={!hidden.before} onClick={() => page(-1)}>
        <Chevron forward={false} />
      </button>
      <button type="button" className="tabs-scroll after" tabIndex={-1} aria-hidden hidden={!hidden.after} onClick={() => page(1)}>
        <Chevron forward />
      </button>
    </div>
  );
}
