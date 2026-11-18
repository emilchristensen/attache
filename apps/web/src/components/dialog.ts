import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** A modal layer is open (a native dialog, the evidence drawer): keys such as Escape belong to it. */
export function modalOpen(): boolean {
  return document.querySelector("dialog[open], [aria-modal='true']") !== null;
}

/**
 * Whether focus is still where a dialog's closing left it: on what had it before the dialog opened (where the browser
 * gives it back), inside the dialog, or nowhere. False once the owner moved on.
 */
function focusLeftByClose(dialog: HTMLDialogElement, before: HTMLElement | null): boolean {
  const active = document.activeElement;
  return !active || active === document.body || active === before || dialog.contains(active) || active.getClientRects().length === 0;
}

/**
 * A native `<dialog>` shown modally while `open`: the browser traps focus and closes it on Escape. However it
 * closes, `onClose` runs and focus goes back to `opener`, or to wherever it was before the dialog opened, so the
 * owner keeps their place. `afterClose` runs after that, for whatever the owner chose inside the dialog.
 *
 * The browser's `close` event comes a task after the dialog closed, and on macOS most of a second later, by when the
 * owner may have gone on (and the page they went to taken focus, or asked for the dialog again). So Escape's `cancel`
 * hands the closing to `onClose`, a dialog this hook closes finishes at once, and the `close` event finishes only a
 * closing nothing finished yet (one the browser would not let `cancel` stop), giving focus back only while it is
 * where the closing left it.
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
  // This opening has finished: its late close event does nothing.
  const settled = useRef(true);
  useLayoutEffect(() => {
    latest.current = { onClose, opener, afterClose };
  });
  const finish = useCallback((d: HTMLDialogElement) => {
    settled.current = true;
    latest.current.onClose();
    if (focusLeftByClose(d, before.current)) (latest.current.opener?.current ?? before.current)?.focus();
    latest.current.afterClose?.();
  }, []);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    // Escape: the owner's state closes the dialog, so asking for it again at once opens it again.
    const cancelled = (e: Event) => {
      e.preventDefault();
      latest.current.onClose();
    };
    // Shown again since, or finished already: the event is stale.
    const closed = () => {
      if (!d.open && !settled.current) finish(d);
    };
    d.addEventListener("cancel", cancelled);
    d.addEventListener("close", closed);
    return () => {
      d.removeEventListener("cancel", cancelled);
      d.removeEventListener("close", closed);
    };
  }, [ref, finish]);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      before.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      settled.current = false;
      d.showModal();
    } else if (!open && d.open) {
      d.close();
      finish(d);
    }
  }, [ref, open, finish]);
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
