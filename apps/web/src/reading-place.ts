import { useEffect, type RefObject } from "react";

/**
 * Keep the reader's place on Home when something above it grows or shrinks, as when a meeting prep Heads-up arrives
 * in For you now (and the Inbox's count line with it) while the owner reads the Inbox. Chrome and Firefox do this
 * themselves (scroll anchoring, `overflow-anchor`). Where the browser does not (Safari), this does the same for
 * Home's scroller: it remembers the first thing in view (an area, or a heading, Heads-up or row) and where it was, and
 * when anything in the page changes size, moves the scroller by as much as that moved. At the top of the page nothing
 * moves.
 */
/** The parts of an area that can hold the place: For you now's heading and Heads-ups, the Inbox's heading and rows. */
const PARTS = ".for-you-now-head, [data-heads-up-key], .inbox-head, [data-inbox-row]";

export function useReadingPlace(scrollerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || anchorsItself() || typeof ResizeObserver === "undefined") return;
    let anchor: { el: Element; top: number } | null = null;
    const remember = () => {
      const view = scroller.getBoundingClientRect();
      // The first thing in view, in page order: an area of Home, or inside For you now and the Inbox their heading or an
      // entry. As with the browser's own anchoring, a change inside or below it moves nothing, and a change above it keeps
      // it put.
      const candidates = [...scroller.children].flatMap((area) => {
        const parts = [...area.querySelectorAll(PARTS)];
        return parts.length ? parts : [area];
      });
      const el = scroller.scrollTop > 0 ? (candidates.find((c) => c.getBoundingClientRect().bottom > view.top && c.getBoundingClientRect().top < view.bottom) ?? null) : null;
      anchor = el ? { el, top: el.getBoundingClientRect().top } : null;
    };
    const keep = () => {
      if (anchor?.el.isConnected) {
        const moved = anchor.el.getBoundingClientRect().top - anchor.top;
        if (moved !== 0) scroller.scrollTop += moved;
      }
      remember();
    };
    const sizes = new ResizeObserver(keep);
    const watch = () => {
      sizes.disconnect();
      for (const child of scroller.children) sizes.observe(child);
    };
    // Areas come and go (For you now mounts after /config answers): watch whatever the page holds now.
    const children = new MutationObserver(watch);
    watch();
    children.observe(scroller, { childList: true });
    remember();
    scroller.addEventListener("scroll", remember, { passive: true });
    return () => {
      sizes.disconnect();
      children.disconnect();
      scroller.removeEventListener("scroll", remember);
    };
  }, [scrollerRef]);
}

let native: boolean | null = null;

/** Whether the browser keeps the place itself. */
function anchorsItself(): boolean {
  native ??= typeof CSS !== "undefined" && CSS.supports("overflow-anchor", "auto");
  return native;
}
