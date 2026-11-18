import { useCallback, useState, type FocusEvent, type PointerEvent } from "react";

/** The value of `attribute` on the closest element at or above `target`, or null. */
function placeOf(target: EventTarget | null, attribute: string): string | null {
  return target instanceof Element ? (target.closest(`[${attribute}]`)?.getAttribute(attribute) ?? null) : null;
}

/**
 * Whether the pointer or the keyboard focus is inside an element, so what it shows can hold still: nothing moves or
 * leaves under the owner. Spread `holdProps` on the element. `holding` names what the pointer and the focus are on:
 * the `attribute` value of the closest element that has one (For you now: each Heads-up's key), so something new can
 * come in below them without moving them.
 */
export function useHold(attribute: string) {
  const [pointer, setPointer] = useState<string | null | false>(false);
  const [focus, setFocus] = useState<string | null | false>(false);
  const onBlur = useCallback((e: FocusEvent<HTMLElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocus(false);
  }, []);
  const onPointer = useCallback((e: PointerEvent<HTMLElement>) => setPointer(placeOf(e.target, attribute)), [attribute]);
  return {
    held: pointer !== false || focus !== false,
    holding: [pointer, focus].filter((k): k is string => typeof k === "string"),
    holdProps: {
      onPointerEnter: onPointer,
      onPointerOver: onPointer,
      onPointerLeave: () => setPointer(false),
      onFocus: (e: FocusEvent<HTMLElement>) => setFocus(placeOf(e.target, attribute)),
      onBlur,
    },
  };
}
