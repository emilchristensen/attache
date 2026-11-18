import { useEffect, type RefObject } from "react";
import type { InboxAnchor } from "../inbox-place.ts";

/**
 * The Inbox's scroll anchor across a visit to a Draft: before View draft leaves Home, the row the owner acted on and
 * where it stood in Home's scroller are kept with the Inbox place (`inbox-place.ts`); when Home comes back, the
 * scroller is moved so that row stands where it stood. Areas above the Inbox (For you now, Connections) can still
 * settle after the rows show, so the place is kept for a moment while they do, and given up as soon as the owner
 * scrolls, types or points.
 */

/** How long Home may take to settle after it comes back before the anchor is let go. */
export const SETTLE_MS = 2000;

const ROW = "[data-inbox-row]";

/** The row with `id` and where it stands in its scroller, or null when it is not on the page. */
export function anchorOf(id: string): InboxAnchor | null {
  const row = document.querySelector<HTMLElement>(`#inbox ${ROW}[data-item-id="${CSS.escape(id)}"]`);
  const scroller = row?.closest<HTMLElement>(".page");
  if (!row || !scroller) return null;
  return { id, top: row.getBoundingClientRect().top - scroller.getBoundingClientRect().top };
}

/** Brings the anchored row back to where it stood once its rows show (`ready`), then calls `done`. */
export function useReturnToAnchor(section: RefObject<HTMLElement | null>, anchor: InboxAnchor | null, ready: boolean, done: () => void): void {
  useEffect(() => {
    if (!anchor || !ready) return;
    const scroller = section.current?.closest<HTMLElement>(".page");
    const row = () => section.current?.querySelector<HTMLElement>(`${ROW}[data-item-id="${CSS.escape(anchor.id)}"]`) ?? null;
    if (!scroller || !row()) {
      done();
      return;
    }
    const place = () => {
      const r = row();
      if (!r) return;
      const moved = r.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.top;
      if (Math.abs(moved) >= 1) scroller.scrollTop += moved;
    };
    place();
    const sizes = new ResizeObserver(place);
    for (const child of scroller.children) sizes.observe(child);
    let held = true;
    const letGo = () => {
      if (!held) return;
      held = false;
      sizes.disconnect();
      window.clearTimeout(timer);
      for (const e of OWNER_INPUT) scroller.removeEventListener(e, letGo);
      done();
    };
    const timer = window.setTimeout(letGo, SETTLE_MS);
    for (const e of OWNER_INPUT) scroller.addEventListener(e, letGo, { passive: true });
    return letGo;
  }, [section, anchor, ready, done]);
}

/** Input that means the owner is moving on their own: the anchor stops holding the place. */
const OWNER_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
