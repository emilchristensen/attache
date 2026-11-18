/**
 * The keys that search the Brain: `Ctrl K` or `Cmd K` anywhere, even inside a text field, and `/` outside one.
 * Pure, so the rules are unit-tested; `shortcuts.ts` listens for them.
 */

export const SEARCH_SLASH = "/";

interface Chord {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** `Ctrl K` or `Cmd K`, with no other modifier. */
export function isSearchChord(e: Chord): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
}

/** The chord as this system writes it, for the keycap in the field and the shortcut sheet. */
export function searchKeyLabel(platform: string): string {
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘ K" : "Ctrl K";
}

/** The browser's platform: `userAgentData` where it exists, the older `navigator.platform` elsewhere. */
export function browserPlatform(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  return nav.userAgentData?.platform || nav.platform || "";
}
