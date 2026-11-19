import { useEffect } from "react";
import { tabTitle, type Tally } from "./count.ts";

/** The two favicons: the mark with the brass dot, and the same mark without it (`public/`). */
export const FAVICON = { dot: "/favicon.svg", quiet: "/favicon-quiet.svg" } as const;

function setFavicon(href: string) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (link && link.getAttribute("href") !== href) link.setAttribute("href", href);
}

/**
 * The browser tab follows the count: the title carries the total ("(14) Attache") and the favicon the dot, so a
 * background tab says at a glance whether a decision waits. Outside the shell (pairing, Setup) both are quiet.
 */
export function useTabSignal(total: Tally, dot: boolean) {
  const title = tabTitle(total);
  useEffect(() => {
    document.title = title;
  }, [title]);
  useEffect(() => {
    setFavicon(dot ? FAVICON.dot : FAVICON.quiet);
  }, [dot]);
  useEffect(
    () => () => {
      document.title = tabTitle({ state: "unknown", count: 0, exact: false });
      setFavicon(FAVICON.quiet);
    },
    [],
  );
}
