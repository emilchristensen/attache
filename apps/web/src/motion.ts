/**
 * How a scroll the Dashboard starts itself moves: it glides ("smooth"), unless the owner's system asks for reduced
 * motion, when it jumps ("auto"). The stylesheet's reduced-motion rule cannot reach a scroll asked for in script.
 */
export function scrollMotion(): ScrollBehavior {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}
