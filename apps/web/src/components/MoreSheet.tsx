import { useId, useRef, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { navBadge, type NavSignals } from "../nav-signals.ts";
import { MORE_SCREENS, screen, type ScreenId } from "../routes.ts";
import { MachinePanel } from "./MachinePanel.tsx";
import { ScreenLink } from "./ScreenLink.tsx";
import { useModalDialog } from "./dialog.ts";

/** The narrow window's More: the screens the bottom bar has no room for, and this Machine's lines. */
export function MoreSheet({ open, onClose, current, signals, opener }: { open: boolean; onClose: () => void; current: ScreenId | null; signals: NavSignals; opener: RefObject<HTMLButtonElement | null> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const title = useId();
  useModalDialog(ref, open, onClose, opener);
  // A followed link closes the sheet: the owner is where they asked to go. A React handler, so it runs after the
  // link's own (which navigates) while the link is still there.
  const followed = (e: ReactMouseEvent) => {
    if ((e.target as Element).closest("a")) onClose();
  };
  return (
    <dialog ref={ref} className="sheet more-sheet" aria-labelledby={title} onClick={followed}>
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
