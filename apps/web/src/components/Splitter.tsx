import { useCallback, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";

/**
 * A vertical drag handle that sizes the pane to its right. The width is kept
 * in localStorage, clamped so the left pane never drops below `minLeft`.
 */
export interface PaneSize {
  key: string;
  initial: number;
  minRight: number;
  minLeft: number;
}

const KEY_STEP = 24;

function stored(size: PaneSize): number {
  const n = Number(localStorage.getItem(size.key));
  return Number.isFinite(n) && n >= size.minRight ? n : size.initial;
}

export function usePaneWidth(size: PaneSize) {
  const [width, setWidth] = useState(() => stored(size));
  const commit = useCallback(
    (w: number) => {
      setWidth(w);
      if (w === size.initial) localStorage.removeItem(size.key);
      else localStorage.setItem(size.key, String(w));
    },
    [size.initial, size.key],
  );
  return [width, commit] as const;
}

export function Splitter({ container, size, width, onResize, label, controls }: { container: RefObject<HTMLElement | null>; size: PaneSize; width: number; onResize: (w: number) => void; label: string; controls: string }) {
  const [dragging, setDragging] = useState(false);
  const max = () => Math.max(size.minRight, (container.current?.clientWidth ?? Infinity) - size.minLeft);
  const clamp = (w: number) => Math.round(Math.min(max(), Math.max(size.minRight, w)));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startWidth = width;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    document.documentElement.classList.add("col-resizing");
    // Dragging left widens the right-hand pane.
    const move = (ev: globalThis.PointerEvent) => onResize(clamp(startWidth - (ev.clientX - startX)));
    const end = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      document.documentElement.classList.remove("col-resizing");
      setDragging(false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next: Record<string, number> = { ArrowLeft: width + KEY_STEP, ArrowRight: width - KEY_STEP, Home: max(), End: size.minRight };
    if (!(e.key in next)) return;
    e.preventDefault();
    onResize(clamp(next[e.key]!));
  };

  return (
    <div
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={size.minRight}
      aria-valuemax={Number.isFinite(max()) ? max() : undefined}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels wide`}
      tabIndex={0}
      title="Drag to resize. Double-click to reset."
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResize(clamp(size.initial))}
    />
  );
}
