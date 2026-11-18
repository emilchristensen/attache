import { useEffect, type RefObject } from "react";

/**
 * Keep the reader's place on Home when something above it grows or shrinks, as when a meeting prep Heads-up arrives
 * in For you now (and the Inbox's count line with it) while the owner reads the Inbox. Chrome and Firefox do this
 * themselves (scroll anchoring, `overflow-anchor`). Where the browser does not (Safari), this does the same for
 * Home's scroller: it remembers the first Inbox row in view and where it was, and when anything in the page changes
 * size, moves the scroller by as much as that row moved. At the top of the page nothing moves, as with the browser's
 * own anchoring.
 */
export function useReadingPlace(scrollerRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || anchorsItself() || typeof ResizeObserver === "undefined") return;
    let anchor: { el: Element; top: number } | null = null;
    const remember = () => {
      const view = scroller.getBoundingClientRect().top;
      const el = [...scroller.querySelectorAll("[data-inbox-row]")].find((r) => r.getBoundingClientRect().bottom > view) ?? null;
      anchor = el && scroller.scrollTop > 0 ? { el, top: el.getBoundingClientRect().top } : null;
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
