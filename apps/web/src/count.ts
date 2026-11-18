import { plural, WAITING_ACTION_STATUSES, type ActionStatus, type ConnectionStatus } from "@attache/contracts";

/**
 * The count behind the logo's dot: the decisions that wait for the owner, in three parts shown in three places.
 *
 * - Home: open Inbox items, minus those whose Draft waits (`draft`, `approved`, `revoked`), since that decision is
 *   the Draft's. A meeting prep item shown as a Heads-up stays counted here: the Heads-up is a view of the item.
 * - Approvals: Proposals in `proposed`, plus Drafts in `draft`, `approved` or `revoked`.
 * - Connections: Connections in `needs_auth`.
 *
 * Every part is known, at its list limit, unknown (not answered yet, or failed) or off (its feature is switched off).
 * The total is exact only when every part is known or off; otherwise what did answer is a lower bound ("N+"), and
 * when nothing answered there is no number. This module is pure: the hook that asks the lists is `nav-signals.ts`.
 * The rules and their test table are in `docs/design/dashboard-redesign/fable/spec-dot-and-drafts.md`, part 1.
 */

/** One list as the Dashboard has it now. `limit` is what the request asked for (null: the route has no limit). */
export type Answer<T> = { kind: "waiting" } | { kind: "failed" } | { kind: "off" } | { kind: "rows"; rows: readonly T[]; limit: number | null };

export interface CountInputs {
  /** Open Inbox items. */
  inbox: Answer<{ actionStatus: ActionStatus | null }>;
  /** Proposals in `proposed`. */
  proposals: Answer<unknown>;
  /** Drafts, asked for in the waiting statuses. */
  drafts: Answer<{ status: ActionStatus }>;
  connections: Answer<Pick<ConnectionStatus, "status">>;
}

export type PartState = "known" | "at_limit" | "unknown" | "off";

/** A part of the count, or the total: what the answered lists add up to, and whether that is the whole number. */
export interface Tally {
  state: PartState;
  count: number;
  /** Known or off: `count` is the number, not a lower bound. */
  exact: boolean;
}

export interface DecisionCount {
  home: Tally;
  approvals: Tally;
  connections: Tally;
  total: Tally;
}

const WAITING = new Set<ActionStatus>(WAITING_ACTION_STATUSES);

/** An Inbox item whose decision is its waiting Draft's, counted in Approvals. */
export const draftWaits = (i: { actionStatus: ActionStatus | null }) => i.actionStatus !== null && WAITING.has(i.actionStatus);

/** One list's share of a part: the rows that count, and the list's condition. */
function source<T>(answer: Answer<T>, counts: (row: T) => boolean): Tally {
  if (answer.kind === "off") return { state: "off", count: 0, exact: true };
  if (answer.kind !== "rows") return { state: "unknown", count: 0, exact: false };
  const full = answer.limit !== null && answer.rows.length >= answer.limit;
  return { state: full ? "at_limit" : "known", count: answer.rows.filter(counts).length, exact: !full };
}

const RANK: Record<PartState, number> = { off: 0, known: 1, at_limit: 2, unknown: 3 };

/** Tallies added up: the worst condition wins, except that off beside anything answered is just known. */
function sum(tallies: Tally[]): Tally {
  const worst = tallies.reduce<PartState>((w, t) => (RANK[t.state] > RANK[w] ? t.state : w), "off");
  return { state: worst, count: tallies.reduce((n, t) => n + t.count, 0), exact: tallies.every((t) => t.exact) };
}

export function countDecisions(inputs: CountInputs): DecisionCount {
  const home = source(inputs.inbox, (i) => !draftWaits(i));
  const approvals = sum([source(inputs.proposals, () => true), source(inputs.drafts, (d) => WAITING.has(d.status))]);
  const connections = source(inputs.connections, (c) => c.status === "needs_auth");
  return { home, approvals, connections, total: sum([home, approvals, connections]) };
}

/** The number as it shows: "4", "4+" for a lower bound, or null when there is nothing to show. */
export function shownCount(t: Tally): string | null {
  return t.count > 0 ? `${t.count}${t.exact ? "" : "+"}` : null;
}

/** The number with its words, for a screen reader: "2 waiting", "at least 2 waiting"; null with no number. */
export function spokenCount(t: Tally, words: (n: number) => string): string | null {
  if (t.count === 0) return null;
  return `${t.exact ? "" : "at least "}${t.count} ${words(t.count)}`;
}

/**
 * Whether the logo's dot shows, given whether it showed before. A decision that is known to wait lights it; only
 * an exact zero puts it out; an unknown part never turns it on or off. On first load `previous` is false.
 */
export function dotAfter(previous: boolean, total: Tally): boolean {
  if (total.count > 0) return true;
  return total.exact ? false : previous;
}

/** The tab title: "(14) Attache", "(12+) Attache", or "Attache" when nothing is known to wait. */
export function tabTitle(total: Tally): string {
  const n = shownCount(total);
  return n ? `(${n}) Attache` : "Attache";
}

/**
 * The line under Home's Inbox heading when its rows and its decisions differ: "1 meeting above · 3 items below need
 * you · 1 Draft in Approvals". `promoted` holds the ids of items shown above as Heads-ups instead of in the list.
 * Null when every row below is a decision on Home, or when the Inbox has not answered.
 */
export function homeLine(inbox: Answer<{ id: string; actionStatus: ActionStatus | null }>, home: Tally, promoted: ReadonlySet<string>): string | null {
  if (inbox.kind !== "rows") return null;
  const above = inbox.rows.filter((i) => promoted.has(i.id) && !draftWaits(i)).length;
  const below = inbox.rows.filter((i) => !promoted.has(i.id));
  const inApprovals = below.filter(draftWaits).length;
  if (above === 0 && inApprovals === 0) return null;
  const decisions = below.length - inApprovals;
  const more = home.exact ? "" : "+";
  return [
    above > 0 && plural(above, "meeting") + " above",
    `${decisions}${more} ${decisions === 1 && !more ? "item below needs" : "items below need"} you`,
    inApprovals > 0 && plural(inApprovals, "Draft") + " in Approvals",
  ]
    .filter(Boolean)
    .join(" · ");
}
