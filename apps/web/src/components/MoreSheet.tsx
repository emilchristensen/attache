import { useId, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { navBadge, type NavSignals } from "../nav-signals.ts";
import { MORE_SCREENS, screen, type ScreenId } from "../routes.ts";
import { MachinePanel } from "./MachinePanel.tsx";
import { ScreenLink } from "./ScreenLink.tsx";
import { useModalDialog } from "./dialog.ts";
import { navigate } from "./ui.tsx";

/** The narrow window's More: the screens the bottom bar has no room for, and this Machine's lines. */
export function MoreSheet({ open, onClose, current, signals, opener }: { open: boolean; onClose: () => void; current: ScreenId | null; signals: NavSignals; opener: RefObject<HTMLButtonElement | null> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const title = useId();
  const follow = useRef<string | null>(null);
  useModalDialog(ref, open, onClose, opener, () => {
    const to = follow.current;
    follow.current = null;
    if (to) navigate(to);
  });
  // A followed link closes the sheet first and goes where it points once the sheet has closed and focus is back on
  // More: the page it opens (a Settings section) may then take focus, which an open modal sheet would not let it.
  // Captured before the link's own handler, which would navigate at once.
  const followed = (e: ReactMouseEvent) => {
    const link = (e.target as Element).closest("a[href]");
    if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    follow.current = link.getAttribute("href");
    onClose();
  };
  return (
    <dialog ref={ref} className="sheet more-sheet" aria-labelledby={title} onClickCapture={followed}>
      <div className="sheet-head">
        <h2 id={title} className="sheet-title">
          More
        </h2>
        <button className="ghost small" onClick={onClose}>
          Close
        </button>
      </div>
      <nav className="more-nav" aria-label="More screens">
        {MORE_SCREENS.map((id) => (
          <ScreenLink key={id} screen={screen(id)} current={current === id} badge={navBadge(signals, id, current)} warning={id === "settings" ? signals.settingsWarning : null} warningShown icon />
        ))}
      </nav>
      {open && (
        <section className="more-machine" aria-label="This Machine">
          <MachinePanel />
        </section>
      )}
    </dialog>
  );
}
