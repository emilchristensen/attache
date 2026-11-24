import { useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { modalOpen } from "./dialog.ts";

/**
 * A menu that opens under its button: a pointer outside it (outside every element in `roots`) or Escape closes it
 * (Escape returns focus to the button, and yields to an open dialog). `chosen` is the menu's React click handler: a
 * click on one of its buttons closes it and returns focus to the button, after the choice's own handler has run.
 */
function useMenuDismiss(open: boolean, close: () => void, roots: ReadonlyArray<RefObject<HTMLElement | null>>, button: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!roots.some((r) => r.current?.contains(e.target as Node))) close();
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || modalOpen()) return;
      close();
      button.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, close, roots, button]);
  return (e: ReactMouseEvent) => {
    if (!(e.target as Element).closest("button")) return;
    close();
    button.current?.focus();
  };
}

/**
 * The one shape of every small list of choices under a button (the Inbox's Snooze times and heading menus, the
 * Connection banner's Actions, Briefing options, the Brain menu), as a plain disclosure (no menu roles): the button says whether
 * it is open, Escape or a pointer outside closes it with focus back on the button, and a choice closes it the same way.
 * The button and the list need not share a parent, so each keeps its place in the layout: spread `buttonProps` on the
 * button and `listProps` on the list, and render the list only while `open`.
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const roots = useMemo(() => [button, list], []);
  const close = useCallback(() => setOpen(false), []);
  const chosen = useMenuDismiss(open, close, roots, button);
  return {
    open,
    buttonProps: { ref: button, "aria-expanded": open, "aria-controls": id, onClick: () => setOpen((o) => !o) },
    listProps: { ref: list, id, role: "group" as const, onClick: chosen },
  };
}
