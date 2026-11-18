import { useEffect, useId, useRef, useState } from "react";
import { keepTabInside, useModalDialog } from "./dialog.ts";
import { SearchField, type PaletteMode } from "./SearchField.tsx";

/** The palette's search field. */
export const PALETTE_SEARCH_ID = "palette-search";

/**
 * Search the Brain on every screen but Home (#34 of spec #14): Home's search field and results in a modal dialog,
 * with a Go to group for every screen and Settings section. Focus stays inside it (Tab wraps); Esc closes it and
 * focus goes back to where it was. A choice closes it first, then opens, so focus lands where the choice leads.
 * Each opening starts with an empty field. Searching only reads: it starts no job and changes nothing.
 */
export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const title = useId();
  const then = useRef<(() => void) | null>(null);
  // A new field each time it opens, so it starts empty.
  const [opening, setOpening] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpening((n) => n + 1);
  }
  const afterClose = () => {
    const go = then.current;
    then.current = null;
    go?.();
  };
  useModalDialog(ref, open, onClose, undefined, afterClose);
  // The dialog would focus its first control, Close; the field is what the owner opened it for.
  useEffect(() => {
    if (open) document.getElementById(PALETTE_SEARCH_ID)?.focus();
  }, [open]);
  const mode: PaletteMode = {
    leave: (go) => {
      then.current = go ?? null;
      onClose();
    },
  };
  return (
    <dialog ref={ref} className="sheet palette" aria-labelledby={title} onKeyDown={(e) => keepTabInside(e.nativeEvent, e.currentTarget)}>
      <div className="sheet-head">
        <h2 id={title} className="sheet-title">
          Search the Brain
        </h2>
        <button className="ghost small" onClick={onClose}>
          Close
        </button>
      </div>
      {open && <SearchField key={opening} id={PALETTE_SEARCH_ID} palette={mode} />}
    </dialog>
  );
}
