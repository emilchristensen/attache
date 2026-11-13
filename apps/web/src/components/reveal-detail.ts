import { useCallback, useRef } from "react";

/** How long a revealed detail is kept in view while its content loads. */
const REVEAL_MS = 1500;
/** What the owner does to scroll by themselves, which ends a reveal. */
const OWN_SCROLL = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/**
 * Whether the detail sits below its list instead of beside it. Side by side,
 * both start at the top of the split; stacked, the detail starts lower.
 */
function stacked(detail: HTMLElement): boolean {
  const split = detail.parentElement;
  return split !== null && detail.getBoundingClientRect().top > split.getBoundingClientRect().top + 1;
}

/**
 * Scrolls the detail into view when it sits below the list. The detail is
 * often still loading and too short to reach the top, so it is scrolled again
 * as it grows, until the owner scrolls or shortly after.
 */
function reveal(detail: HTMLElement) {
  const show = () => {
    if (stacked(detail)) detail.scrollIntoView({ block: "start" });
  };
  const growing = new ResizeObserver(show);
  const stop = () => {
    growing.disconnect();
    clearTimeout(timer);
    for (const type of OWN_SCROLL) window.removeEventListener(type, stop, true);
  };
  const timer = setTimeout(stop, REVEAL_MS);
  // After the click has rendered the picked item's detail.
  requestAnimationFrame(() => {
    if (!stacked(detail)) return stop();
    show();
    growing.observe(detail);
    for (const type of OWN_SCROLL) window.addEventListener(type, stop, { capture: true, passive: true });
  });
}

/**
 * For a list beside its detail (`.split`): the ref for the detail, and a
 * function to call when the owner picks an item. On a narrow screen the detail
 * sits below the list, out of sight, so picking scrolls it into view; beside
 * the list nothing moves.
 */
export function useRevealDetail() {
  const detailRef = useRef<HTMLDivElement>(null);
  const revealDetail = useCallback(() => {
    if (detailRef.current) reveal(detailRef.current);
  }, []);
  return { detailRef, revealDetail };
}
