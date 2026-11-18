import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** A modal layer is open (a native dialog, the evidence drawer): keys such as Escape belong to it. */
export function modalOpen(): boolean {
  return document.querySelector("dialog[open], [aria-modal='true']") !== null;
}

/**
 * A native `<dialog>` shown modally while `open`: the browser traps focus and closes it on Escape. However it
 * closes, `onClose` runs and focus goes back to `opener`, or to wherever it was before the dialog opened, so the
 * owner keeps their place. `afterClose` runs after that, for whatever the owner chose inside the dialog.
 */
export function useModalDialog(
  ref: RefObject<HTMLDialogElement | null>,
  open: boolean,
  onClose: () => void,
  opener?: RefObject<HTMLElement | null>,
  afterClose?: () => void,
): void {
  const latest = useRef({ onClose, opener, afterClose });
  const before = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    latest.current = { onClose, opener, afterClose };
  });
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const closed = () => {
      // The close event comes a moment after the dialog closed; if it was shown again in between, it is stale.
      if (d.open) return;
      latest.current.onClose();
      (latest.current.opener?.current ?? before.current)?.focus();
      latest.current.afterClose?.();
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

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

/**
 * Keeps `Tab` and `Shift+Tab` inside `container`: from its last control to its first and back. A modal dialog
 * alone lets focus leave the page for the browser's own controls after its last one.
 */
export function keepTabInside(e: KeyboardEvent, container: HTMLElement): void {
  if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
  const controls = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
  const first = controls[0];
  const last = controls[controls.length - 1];
  if (!first || !last) return;
  const at = document.activeElement;
  if (e.shiftKey && (at === first || !container.contains(at))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (at === last || !container.contains(at))) {
    e.preventDefault();
    first.focus();
  }
}
