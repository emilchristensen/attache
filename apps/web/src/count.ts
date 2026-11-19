import { plural, WAITING_ACTION_STATUSES, type ActionStatus, type ConnectionStatus, type DecisionTotals } from "@attache/contracts";

/**
 * The count behind the logo's dot: the decisions that wait for the owner, in three parts shown in three places.
 *
 * - Home: open Inbox items, minus those whose Draft waits (`draft`, `approved`, `revoked`), since that decision is
 *   the Draft's. A meeting prep item shown as a Heads-up stays counted here: the Heads-up is a view of the item.
 * - Approvals: Proposals in `proposed`, plus Drafts in `draft`, `approved` or `revoked`.
 * - Connections: Connections in `needs_auth`.
 *
 * The parts come from the count route (`GET /decision-count`), whose totals are exact however many items wait. When
 * the route fails the module falls back to the lists the screens show, which stop at their limits.
 *
 * Every part is known, at its list limit, unknown (not answered yet, or failed) or off (its feature is switched off).
 * The total is exact only when every part is known or off; otherwise what did answer is a lower bound ("N+"), and
 * when nothing answered there is no number. This module is pure: the hook that asks the route and the lists is
 * `nav-signals.ts`.
 * The rules and their test table are in `docs/design/dashboard-redesign/fable/spec-dot-and-drafts.md`, part 1.
 */

/** One list as the Dashboard has it now. `limit` is what the request asked for (null: the route has no limit). */
export type Answer<T> = { kind: "waiting" } | { kind: "failed" } | { kind: "off" } | { kind: "rows"; rows: readonly T[]; limit: number | null };

/** The count route's answer: its totals, or why there are none (yet). */
export type Totals = { kind: "waiting" } | { kind: "failed" } | { kind: "totals"; totals: DecisionTotals };

/** The lists the count falls back to when the count route fails. */
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

/** One of the route's totals as a part: exact, or off. */
function total(n: number | "off"): Tally {
  return n === "off" ? { state: "off", count: 0, exact: true } : { state: "known", count: n, exact: true };
}

const UNKNOWN: Tally = { state: "unknown", count: 0, exact: false };

/**
 * The count: from the route's totals when it answered; from the lists when it failed. While the route has not
 * answered yet, the parts are unknown, so a full list never shows "200+" for a moment before the exact number.
 */
export function countDecisions(totals: Totals, lists: CountInputs): DecisionCount {
  if (totals.kind === "failed") return fromLists(lists);
  if (totals.kind === "waiting") return { home: UNKNOWN, approvals: UNKNOWN, connections: UNKNOWN, total: UNKNOWN };
  const t = totals.totals;
  const home = total(t.inbox);
  const approvals = sum([total(t.proposals), total(t.drafts)]);
  const connections = total(t.signIns);
  return { home, approvals, connections, total: sum([home, approvals, connections]) };
}

/**
 * The totals to count from while Home's rows are asked again. `fresh` is the route's latest answer; `withShownRows`
 * the answer held with the Inbox and Drafts rows on screen. The Inbox and Drafts parts change with those rows, so a
 * number never disagrees with the list beside it; Proposals and sign-ins count as they arrive. With no answer held
 * yet (first load), the fresh one counts whole; a fresh failure or wait stands as it is. When the route had failed
 * with the rows on screen, the count stays with those lists (the fallback) until the rows are asked again with the
 * route, so a recovered route never changes the number beside rows it was not read with.
 */
export function withRows(fresh: Totals, withShownRows: Totals): Totals {
  if (fresh.kind !== "totals" || withShownRows.kind === "waiting") return fresh;
  if (withShownRows.kind === "failed") return withShownRows;
  return { kind: "totals", totals: { ...fresh.totals, inbox: withShownRows.totals.inbox, drafts: withShownRows.totals.drafts } };
}

function fromLists(inputs: CountInputs): DecisionCount {
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
 * What a screen reader hears after a Source refresh that changed what counts (spec #14 story 22): the total in words,
 * "4 need you now.", or "Nothing needs you now." for an exact zero. An unknown part never claims that nothing waits.
 */
export function refreshAnnouncement(after: Tally, words: (n: number) => string): string | null {
  if (after.count === 0) return after.exact ? "Nothing needs you now." : null;
  const said = `${spokenCount(after, words)} now.`;
  return said.charAt(0).toUpperCase() + said.slice(1);
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
 * you · 1 Draft in Approvals". `promoted` holds the ids of items shown above as Heads-ups instead of in the list;
 * `home` is the heading's count. While the list holds every open item the line counts its rows; when the list is
 * full (more items than it asked for), the decisions below come from the count and the Drafts are a lower bound.
 * Null when every row below is a decision on Home, or when the Inbox has not answered.
 */
export function homeLine(inbox: Answer<{ id: string; actionStatus: ActionStatus | null }>, promoted: ReadonlySet<string>, home: Tally): string | null {
  if (inbox.kind !== "rows") return null;
  const above = inbox.rows.filter((i) => promoted.has(i.id) && !draftWaits(i)).length;
  const below = inbox.rows.filter((i) => !promoted.has(i.id));
  const inApprovals = below.filter(draftWaits).length;
  if (above === 0 && inApprovals === 0) return null;
  const full = inbox.limit !== null && inbox.rows.length >= inbox.limit;
  const decisions = full && home.exact ? home.count - above : below.length - inApprovals;
  const atLeast = full && !home.exact ? "At least " : "";
  return [
    above > 0 && plural(above, "meeting") + " above",
    `${atLeast}${plural(decisions, "item")} below ${decisions === 1 && !atLeast ? "needs" : "need"} you`,
    inApprovals > 0 && `${full ? "at least " : ""}${plural(inApprovals, "Draft")} in Approvals`,
  ]
    .filter(Boolean)
    .join(" · ");
}
