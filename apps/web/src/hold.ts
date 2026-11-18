import { useCallback, useState, type FocusEvent } from "react";

/**
 * Whether the pointer or the keyboard focus is inside an element, so what it shows can hold still: nothing moves or
 * leaves under the owner. Spread `holdProps` on the element.
 */
export function useHold() {
  const [pointer, setPointer] = useState(false);
  const [focus, setFocus] = useState(false);
  const onBlur = useCallback((e: FocusEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false);
  }, []);
  return {
    held: pointer || focus,
    holdProps: {
      onPointerEnter: () => setPointer(true),
      onPointerLeave: () => setPointer(false),
      onFocus: () => setFocus(true),
      onBlur,
    },
  };
}
