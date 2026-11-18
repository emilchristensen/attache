import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * A native `<dialog>` shown modally while `open`: the browser traps focus and closes it on Escape. However it
 * closes, `onClose` runs and focus goes back to `opener`, or to wherever it was before the dialog opened, so the
 * owner keeps their place.
 */
export function useModalDialog(ref: RefObject<HTMLDialogElement | null>, open: boolean, onClose: () => void, opener?: RefObject<HTMLElement | null>): void {
  const latest = useRef({ onClose, opener });
  const before = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    latest.current = { onClose, opener };
  });
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const closed = () => {
      latest.current.onClose();
      (latest.current.opener?.current ?? before.current)?.focus();
    };
    d.addEventListener("close", closed);
    return () => d.removeEventListener("close", closed);
  }, [ref]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      before.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      d.showModal();
    } else if (!open && d.open) {
      d.close();
    }
  }, [ref, open]);
}
