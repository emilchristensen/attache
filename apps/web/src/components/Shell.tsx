import { useCallback, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { SignalsContext, useNavSignals } from "../nav-signals.ts";
import { screenAt } from "../routes.ts";
import { focusHomeSearch } from "../search-launch.ts";
import { useShortcuts } from "../shortcuts.ts";
import { useTabSignal } from "../tab-signal.ts";
import { ReaderWarning } from "../views/ReaderLine.tsx";
import { BottomBar } from "./BottomBar.tsx";
import { Masthead } from "./Masthead.tsx";
import { MoreSheet } from "./MoreSheet.tsx";
import { SearchPalette } from "./SearchPalette.tsx";
import { ShortcutSheet } from "./ShortcutSheet.tsx";
import { ErrorBoundary } from "./ui.tsx";

/** The skip link moves focus to the page without putting `#main` in the address. */
function skipToContent(e: MouseEvent<HTMLAnchorElement>) {
  e.preventDefault();
  document.getElementById("main")?.focus();
}

/**
 * The frame around every screen: the masthead (desktop) or the bottom bar (narrow), the silent-Reader warning that
 * stays in view, the page in a centred reading column, the More and shortcut sheets and the search palette. It asks for the count once
 * and shares it with the screens (`useSignals()`), and the browser tab's title and favicon follow it.
 */
export function Shell({ children, path }: { children: ReactNode; path: string }) {
  const current = screenAt(path);
  const signals = useNavSignals();
  const [sheet, setSheet] = useState<"more" | "shortcuts" | "search" | null>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  // Each sheet closes only itself: a sheet's close event arrives a moment late, after another may have opened.
  const closeMore = useCallback(() => setSheet((s) => (s === "more" ? null : s)), []);
  const closeShortcuts = useCallback(() => setSheet((s) => (s === "shortcuts" ? null : s)), []);
  const closeSearch = useCallback(() => setSheet((s) => (s === "search" ? null : s)), []);
  const openShortcuts = useCallback(() => setSheet("shortcuts"), []);
  // Home's field when it is on screen, the search palette everywhere else.
  const search = useCallback(() => {
    if (current === "home") focusHomeSearch();
    else setSheet("search");
  }, [current]);
  const reopenSearch = useCallback(() => setSheet("search"), []);
  useShortcuts(openShortcuts, search);
  // Browser Back or Forward under the open palette takes the owner somewhere else: the palette closes.
  const [shownPath, setShownPath] = useState(path);
  if (path !== shownPath) {
    setShownPath(path);
    if (sheet === "search") setSheet(null);
  }
  useTabSignal(signals.count.total, signals.dot);
  return (
    <SignalsContext.Provider value={signals}>
    <div className="shell">
      <a className="skip-link" href="#main" onClick={skipToContent}>
        Skip to content
      </a>
      <Masthead current={current} signals={signals} onSearch={search} />
      <ReaderWarning />
      <main id="main" className="main" tabIndex={-1}>
        <ErrorBoundary>{children}</ErrorBoundary>
      </main>
      <BottomBar current={current} signals={signals} moreOpen={sheet === "more"} onMore={() => setSheet("more")} moreRef={moreButton} onSearch={search} />
      <MoreSheet open={sheet === "more"} onClose={closeMore} current={current} signals={signals} opener={moreButton} />
      <ShortcutSheet open={sheet === "shortcuts"} onClose={closeShortcuts} />
      <SearchPalette open={sheet === "search"} onClose={closeSearch} onReopen={reopenSearch} />
    </div>
    </SignalsContext.Provider>
  );
}
