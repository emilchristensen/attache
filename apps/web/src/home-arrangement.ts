import { useSyncExternalStore } from "react";

/**
 * Home's arrangement follows the window (spec #82): a phone below 600 px, as `styles/home.css` draws it.
 * The areas are put in the document in the order they are drawn, so a keyboard and a screen reader meet them in the
 * order the owner sees them (WCAG 2.4.3); CSS `order` would draw one order and read another.
 */
export const PHONE_WINDOW_QUERY = "(max-width: 599px)";

/** The areas Home places after The Daily Briefing. */
export type HomeArea = "your-day" | "for-you-now" | "inbox";

const WIDE_ORDER: readonly HomeArea[] = ["your-day", "for-you-now", "inbox"];
const PHONE_ORDER: readonly HomeArea[] = ["for-you-now", "your-day", "inbox"];

/** Wide: Your day across the top, then For you now beside the Inbox. Phone: For you now before Your day. */
export const homeAreaOrder = (phone: boolean): readonly HomeArea[] => (phone ? PHONE_ORDER : WIDE_ORDER);

function phoneQuery(): MediaQueryList | null {
  return typeof window.matchMedia === "function" ? window.matchMedia(PHONE_WINDOW_QUERY) : null;
}

function subscribe(onChange: () => void): () => void {
  const query = phoneQuery();
  query?.addEventListener("change", onChange);
  return () => query?.removeEventListener("change", onChange);
}

const isPhoneWindow = () => phoneQuery()?.matches ?? false;

/** Whether the window is phone-wide, updated as it is resized. */
export function usePhoneWindow(): boolean {
  return useSyncExternalStore(subscribe, isPhoneWindow, () => false);
}
