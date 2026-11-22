/**
 * What The Daily Briefing area on Home shows (pure, table tests in `apps/web/test/briefing-area.test.ts`): today's
 * Daily Briefing in the browser's zone, an away summary or a briefing the owner asked for above it for a while, and
 * which of its states the area is in.
 */
import type { BriefingView } from "@attache/contracts";
import { REQUESTED_BRIEFING_STAYS_MS } from "./heads-up-rules.ts";
import { dayKey } from "./zoned-time.ts";

/** The key Got it remembers a briefing by (`heads-up-memory.ts`). */
export const settledKey = (briefing: Pick<BriefingView, "id">) => `briefing:${briefing.id}`;

/** The latest Daily Briefing when it was written today in `timeZone`: it stays until the next one or midnight. */
export function todaysDaily(daily: BriefingView | null, now: number, timeZone: string): BriefingView | null {
  return daily && dayKey(Date.parse(daily.createdAt), timeZone) === dayKey(now, timeZone) ? daily : null;
}

/** An away summary or a briefing the owner asked for, until Got it or four hours after it was made. */
export function requestedShown(requested: BriefingView | null, settled: ReadonlySet<string>, now: number): BriefingView | null {
  if (!requested || settled.has(settledKey(requested))) return null;
  return now < Date.parse(requested.createdAt) + REQUESTED_BRIEFING_STAYS_MS ? requested : null;
}

export type AreaState = "off" | "writing" | "failed" | "checking" | "none" | "folded" | "card";

/** Which state the area is in, the first that holds: off, a briefing being written, a failure, then what was found. */
export function areaState(i: { attentionOn: boolean; writing: boolean; failed: boolean; answered: boolean; daily: BriefingView | null; folded: boolean }): AreaState {
  if (!i.attentionOn) return "off";
  if (i.writing) return "writing";
  if (!i.answered) return i.failed ? "failed" : "checking";
  if (!i.daily) return "none";
  return i.folded ? "folded" : "card";
}

/**
 * Where an entry of the briefing page leads: a Draft waiting for review to its own page, a Proposal to Approvals, and
 * everything else to its Inbox item on Home. `sectionId` is the briefing section the entry is in, when it is in one.
 */
export type EntryTarget = { kind: "draft"; id: string } | { kind: "proposal"; id: string } | { kind: "inbox"; id: string };

const SECTION_TARGET: Readonly<Record<string, EntryTarget["kind"]>> = { prepared: "draft", memory: "proposal" };

export function entryTarget(briefing: Pick<BriefingView, "sections">, itemId: string): EntryTarget {
  const section = briefing.sections.find((s) => s.items.some((i) => i.id === itemId));
  return { kind: (section && SECTION_TARGET[section.id]) ?? "inbox", id: itemId };
}

/** "First on your list": the lead's words, or that nothing comes first when the Inbox was empty. */
export function leadWords(briefing: BriefingView): { headline: string; explanation: string } {
  return briefing.lead ? { headline: briefing.lead.headline, explanation: briefing.lead.explanation } : { headline: "Nothing needs you first", explanation: briefing.summary };
}
