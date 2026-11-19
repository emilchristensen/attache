import type { IconName } from "./components/icons.tsx";
import { SCREENS, SETTINGS_SECTIONS, settingsHref } from "./routes.ts";

/**
 * The search palette's Go to group (#34 of spec #14): every screen and every Settings section, matched by what the
 * owner types into the palette's search field. Pure, so the matching is unit-tested.
 */

export interface GoToEntry {
  kind: "screen" | "section";
  label: string;
  href: string;
  icon: IconName;
  /** Words that find the place without being its name: a section is found under "Settings" and its group. */
  context: readonly string[];
  /** The quiet line beside the name: "Screen", "Settings · Brain". */
  meta: string;
}

/** How many places Go to shows while the owner types; with an empty field it shows them all. */
export const GO_TO_LIMIT = 4;

export const GO_TO: readonly GoToEntry[] = [
  ...SCREENS.map((s): GoToEntry => ({ kind: "screen", label: s.label, href: s.to, icon: s.icon, context: [], meta: "Screen" })),
  ...SETTINGS_SECTIONS.map(
    (s): GoToEntry => ({ kind: "section", label: s.label, href: settingsHref(s.id), icon: "settings", context: ["Settings", s.group], meta: `Settings · ${s.group}` }),
  ),
];

const words = (text: string): string[] => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Whether every typed word starts a word in `of`. */
const allStart = (typed: readonly string[], of: readonly string[]) => typed.every((t) => of.some((w) => w.startsWith(t)));

/**
 * The places that match `query`: each typed word must start a word of the place's name or its context. Places
 * whose own name matches every word come first, then those found through their context, each in Go to's order.
 */
export function goToMatches(query: string, entries: readonly GoToEntry[] = GO_TO): readonly GoToEntry[] {
  const typed = words(query);
  if (typed.length === 0) return entries;
  const byName = entries.filter((e) => allStart(typed, words(e.label)));
  const byContext = entries.filter((e) => !byName.includes(e) && allStart(typed, [...words(e.label), ...e.context.flatMap(words)]));
  return [...byName, ...byContext].slice(0, GO_TO_LIMIT);
}
