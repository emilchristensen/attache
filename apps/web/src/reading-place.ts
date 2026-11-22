import { useEffect, type RefObject } from "react";

/**
 * Keep the reader's place on Home when something above it grows or shrinks, as when an entry arrives in For you now
 * or The Daily Briefing folds while the owner reads the Inbox. Chrome and Firefox do this
 * themselves (scroll anchoring, `overflow-anchor`). Where the browser does not (Safari), this does the same for
 * Home's scroller: it remembers what is in view (areas, or headings, entries and rows) and where each was, and when
 * anything in the page changes size, moves the scroller by as much as the first of them still on the page moved. At
 * the top of the page nothing moves.
 */
/** The parts of an area that can hold the place: For you now's heading, the Inbox's heading, and both lists' rows. */
const PARTS = ".for-you-now-head, .inbox-head, [data-inbox-row]";

export function useReadingPlace(scrollerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || anchorsItself() || typeof ResizeObserver === "undefined") return;
    // Everything in view, in page order, with where it was: the first one still on the page holds the place (the first
    // can be the very meeting that just moved up into For you now).
    let anchors: Array<{ el: Element; top: number }> = [];
    const remember = () => {
      const view = scroller.getBoundingClientRect();
      // What is in view, in page order: Home's areas, or inside For you now and the Inbox their heading and entries. As
      // with the browser's own anchoring, a change inside or below the first moves nothing, and a change above it keeps it put.
      const candidates = [...scroller.children].flatMap((area) => {
        const parts = [...area.querySelectorAll(PARTS)];
        return parts.length ? parts : [area];
      });
      const inView = scroller.scrollTop > 0 ? candidates.filter((c) => c.getBoundingClientRect().bottom > view.top && c.getBoundingClientRect().top < view.bottom) : [];
      anchors = inView.map((el) => ({ el, top: el.getBoundingClientRect().top }));
    };
    const keep = () => {
      const anchor = anchors.find((a) => a.el.isConnected);
      if (anchor) {
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
