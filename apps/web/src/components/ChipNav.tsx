import { useLayoutEffect, useRef } from "react";
import { navigate } from "./ui.tsx";

export interface ChipLink<T extends string> {
  id: T;
  label: string;
  href: string;
}

/** Room left beside a chip scrolled into view, so its edge and focus ring are not cut. */
const CHIP_MARGIN = 8;

/** Scrolls the row, and only the row, so the chosen chip shows in full. */
function showCurrent(list: HTMLElement) {
  const chip = list.querySelector<HTMLElement>('[aria-current="true"]');
  if (!chip || list.scrollWidth <= list.clientWidth) return;
  const left = chip.getBoundingClientRect().left - list.getBoundingClientRect().left + list.scrollLeft;
  const right = left + chip.offsetWidth;
  if (left < list.scrollLeft) list.scrollLeft = Math.max(0, left - CHIP_MARGIN);
  else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth + CHIP_MARGIN;
}

/**
 * A row of links that choose where the page is, such as a collection or a filter; the chosen one has
 * `aria-current`. When the row is wider than its column it scrolls sideways (the stylesheet decides the look), and the
 * chosen link is kept in view: when it changes, and when the row or a chip changes size (Inter arriving after the
 * first layout).
 */
export function ChipNav<T extends string>({ label, className, items, current, onChoose }: { label: string; className: string; items: ReadonlyArray<ChipLink<T>>; current: T; onChoose?: (id: T) => void }) {
  const listRef = useRef<HTMLUListElement>(null);
  // The chips themselves, not the array: a new array with the same chips must not scroll the row back.
  const chips = items.map((i) => i.id).join(" ");
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    showCurrent(list);
    const sizes = new ResizeObserver(() => showCurrent(list));
    sizes.observe(list);
    for (const chip of list.children) sizes.observe(chip);
    return () => sizes.disconnect();
  }, [current, chips]);
  return (
    <nav className={className} aria-label={label}>
      <ul ref={listRef}>
        {items.map((item) => (
          <li key={item.id}>
            <a
              href={item.href}
              aria-current={item.id === current ? "true" : undefined}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                if (onChoose) onChoose(item.id);
                else navigate(item.href);
              }}
            >
              {item.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
