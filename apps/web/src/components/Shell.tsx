import { useCallback, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useNavSignals } from "../nav-signals.ts";
import { screenAt } from "../routes.ts";
import { useShortcuts } from "../shortcuts.ts";
import { ReaderWarning } from "../views/ReaderLine.tsx";
import { BottomBar } from "./BottomBar.tsx";
import { Masthead } from "./Masthead.tsx";
import { MoreSheet } from "./MoreSheet.tsx";
import { ShortcutSheet } from "./ShortcutSheet.tsx";
import { ErrorBoundary } from "./ui.tsx";

/** The skip link moves focus to the page without putting `#main` in the address. */
function skipToContent(e: MouseEvent<HTMLAnchorElement>) {
  e.preventDefault();
  document.getElementById("main")?.focus();
}

/**
 * The frame around every screen: the masthead (desktop) or the bottom bar (narrow), the silent-Reader warning that
 * stays in view, the page in a centred reading column, and the More and shortcut sheets.
 */
export function Shell({ children, path }: { children: ReactNode; path: string }) {
  const current = screenAt(path);
  const signals = useNavSignals();
  const [sheet, setSheet] = useState<"more" | "shortcuts" | null>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setSheet(null), []);
  const openShortcuts = useCallback(() => setSheet("shortcuts"), []);
  useShortcuts(openShortcuts);
  return (
    <div className="shell">
      <a className="skip-link" href="#main" onClick={skipToContent}>
        Skip to content
      </a>
      <Masthead current={current} signals={signals} />
      <ReaderWarning />
      <main id="main" className="main" tabIndex={-1}>
        <ErrorBoundary>{children}</ErrorBoundary>
      </main>
      <BottomBar current={current} signals={signals} moreOpen={sheet === "more"} onMore={() => setSheet("more")} moreRef={moreButton} />
      <MoreSheet open={sheet === "more"} onClose={close} current={current} signals={signals} opener={moreButton} />
      <ShortcutSheet open={sheet === "shortcuts"} onClose={close} />
    </div>
  );
}
