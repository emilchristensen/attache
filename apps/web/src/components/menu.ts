import { useEffect, type MouseEvent as ReactMouseEvent, type RefObject } from "react";
import { modalOpen } from "./dialog.ts";

/**
 * A menu that opens under its button: a pointer outside it or Escape closes it (Escape returns focus to the button,
 * and yields to an open dialog). `chosen` is the menu's React click handler: a click on one of its buttons closes it
 * and returns focus to the button, after the choice's own handler has run.
 */
export function useMenuDismiss(open: boolean, close: () => void, root: RefObject<HTMLElement | null>, button: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) close();
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
  }, [open, close, root, button]);
  return (e: ReactMouseEvent) => {
    if (!(e.target as Element).closest("button")) return;
    close();
    button.current?.focus();
  };
}
