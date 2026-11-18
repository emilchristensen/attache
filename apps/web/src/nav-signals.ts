import { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { DECISION_COUNT_PATH, WAITING_ACTION_STATUSES, type ActionView, type AttentionItemView, type ConnectionStatus, type DecisionTotals, type ProposalView, type ReplicationStatus, type ReplicationView } from "@attache/contracts";
import { countDecisions, dotAfter, shownCount, spokenCount, withRows, type Answer, type DecisionCount, type Tally, type Totals } from "./count.ts";
import type { ApiError } from "./api.ts";
import { useResource, type Resource } from "./live.ts";
import { pairFailure } from "./pair.ts";
import type { ScreenId } from "./routes.ts";

/**
 * What the navigation shows beside a screen's name: the decisions waiting there (from the count in `count.ts`), and
 * the named Replication warning on Settings. The shell asks for the count route and the lists once, in
 * `useNavSignals()`, and shares the answer with the screens through `useSignals()`, so the masthead, the bottom bar,
 * More, the logo, the favicon, the tab title and Home's Inbox heading all show one count.
 */

/** A number beside a screen's name, and what a screen reader hears after the name: "Approvals, 2 waiting". */
export interface Badge {
  /** As it shows: "2", or "2+" for a lower bound. */
  shown: string;
  /** The number with what it counts: "2 waiting", "at least 1 needs you", "1 sign-in needed". */
  label: string;
}

export interface NavSignals {
  badges: Partial<Record<ScreenId, Badge>>;
  /** The count behind the badges, the logo's dot and the tab title. */
  count: DecisionCount;
  /** Whether the logo and favicon carry the dot: on while a decision is known to wait; an unknown leaves it as it was. */
  dot: boolean;
  /** The open Inbox items as the count read them, for Home's line relating rows to decisions. */
  inbox: Answer<AttentionItemView>;
  /** The rows behind `inbox`, as the count holds them: Home lists these, and its Retry asks the Inbox, the Drafts and the count again. */
  openInbox: Resource<{ items: AttentionItemView[] }>;
  /** The waiting Drafts and the Proposals as the count read them, for Approvals' empty state. */
  drafts: Answer<ActionView>;
  proposals: Answer<ProposalView>;
  /**
   * The rows behind `drafts` and `proposals`, as the count holds them: Approvals lists these, so its sections, its
   * Waiting tab and the navigation agree. The Drafts' Retry asks the Inbox, the Drafts and the count again, like Home's.
   */
  waitingDrafts: Resource<ActionView[]>;
  waitingProposals: Resource<{ proposals: ProposalView[] }>;
  /** "Replication blocked" or "Replication unauthorized" while it is; null otherwise. */
  settingsWarning: string | null;
}

/**
 * The list limits the shell asks for. The count comes from the count route, exact at any size; only when that route
 * fails does it fall back to these lists, and then a full answer makes its part a lower bound ("N+").
 */
export const COUNT_LIMITS = { inbox: 200, proposals: 100, drafts: 100 } as const;

const needYou = (n: number) => (n === 1 ? "needs you" : "need you");
const WORDS: Record<"home" | "approvals" | "connections", (n: number) => string> = {
  home: needYou,
  approvals: () => "waiting",
  connections: (n) => (n === 1 ? "sign-in needed" : "sign-ins needed"),
};

/** The total as a screen reader hears it after the mark's name: "14 need you", "at least 12 need you". */
export const spokenTotal = (total: Tally) => spokenCount(total, needYou);

/**
 * A list as the count reads it. `on` is the feature switch from `/config`: null while that has not answered, false
 * when the feature is off (the list is not asked for). A `feature_disabled` refusal is off too, not a failure.
 */
function answer<R, T>(r: Pick<Resource<R>, "data" | "error">, on: boolean | null, rows: (data: R) => readonly T[], limit: number | null): Answer<T> {
  if (on === false || r.error?.code === "feature_disabled") return { kind: "off" };
  if (r.error) return { kind: "failed" };
  if (on === null || !r.data) return { kind: "waiting" };
  return { kind: "rows", rows: rows(r.data), limit };
}

function badge(t: Tally, words: (n: number) => string): Badge | undefined {
  const shown = shownCount(t);
  const label = spokenCount(t, words);
  return shown && label ? { shown, label } : undefined;
}

const PROBLEM_WORDS: Partial<Record<ReplicationStatus, string>> = { blocked: "Replication blocked", unauthorized: "Replication unauthorized" };

/** Every event after which the count route may answer differently: Inbox items, Drafts, Proposals, sign-ins, features. */
const COUNT_EVENTS = ["attention.changed", "actions.changed", "briefing.created", "memory.changed", "connections.changed", "config.changed"];

/** The count route's answer as the count reads it. Any error, even with an earlier answer kept, falls back to the lists. */
function totalsAnswer(r: Pick<Resource<DecisionTotals>, "data" | "error">): Totals {
  if (r.error) return { kind: "failed" };
  return r.data ? { kind: "totals", totals: r.data } : { kind: "waiting" };
}

/** Asks the count route and the lists behind the screens. Called once, by the shell; screens read the result with `useSignals()`. */
export function useNavSignals(): NavSignals {
  const cfg = useResource<{ features: Record<string, boolean> }>("/config", ["config.changed"]);
  const feature = (id: string) => (cfg.data ? (cfg.data.features[id] ?? false) : null);
  const attentionOn = feature("attention");
  const draftsOn = feature("drafts");
  // A Draft's status shows on its Inbox item, so the Inbox follows Draft changes too; housekeeping announces an
  // expired Draft on both events.
  const inbox = useResource<{ items: AttentionItemView[] }>(attentionOn ? `/attention?state=open&limit=${COUNT_LIMITS.inbox}` : null, ["attention.changed", "actions.changed", "briefing.created"]);
  const drafts = useResource<ActionView[]>(draftsOn ? `/actions?status=${WAITING_ACTION_STATUSES.join(",")}&limit=${COUNT_LIMITS.drafts}` : null, ["actions.changed", "attention.changed"]);
  const proposals = useResource<{ proposals: ProposalView[] }>(`/memory/proposals?status=proposed&limit=${COUNT_LIMITS.proposals}`, ["memory.changed"]);
  const totals = useResource<DecisionTotals>(DECISION_COUNT_PATH, COUNT_EVENTS);
  const replication = useResource<ReplicationView>("/replication", ["replication.changed", "config.changed"]);

  // An Inbox item and its Draft are one decision, counted on Home or in Approvals by the item's Draft status. The two
  // lists are always asked together (the same live events, and one Retry for both), and a new answer from one is
  // held until the other has answered too; otherwise the fallback count would show the decision twice, or not at
  // all, for as long as the slower request takes. Home's and Approvals' rows come from the same held answer.
  // The count route deduplicates in one query, so its first answer counts at once, whatever the lists are doing.
  // Once rows are on screen, a refresh holds the rows and the route's answer until all three have answered, and the
  // Inbox and Drafts parts are counted from that held answer (`withRows`): the rows and the number beside them change
  // together, whichever answers first. Proposals and sign-ins count from the latest answer.
  const held = <R>(r: Resource<R>) => ({ data: r.data, error: r.error, answeredAt: r.answeredAt, askedAt: r.askedAt });
  const settled = useRef({ inbox: held(inbox), drafts: held(drafts), totals: held(totals) });
  const rowsShown = settled.current.inbox.data !== null || settled.current.drafts.data !== null;
  const routeLoading = rowsShown && totals.loading;
  const pairSettled = !inbox.loading && !drafts.loading && !routeLoading;
  if (pairSettled) settled.current = { inbox: held(inbox), drafts: held(drafts), totals: held(totals) };
  const { inbox: heldInbox, drafts: heldDrafts, totals: heldTotals } = settled.current;
  const countedTotals = withRows(totalsAnswer(totals), totalsAnswer(heldTotals));
  // No screen lists the Connections from here, so they are asked only for the fallback, while the count uses it.
  const connections = useResource<ConnectionStatus[]>(countedTotals.kind === "failed" ? "/connections" : null, ["connections.changed"]);
  // A failure is not held for its pair: it shows at once and stays until the pair settles again (`pair.ts`).
  const failures = useRef<{ inbox: ApiError | null; drafts: ApiError | null }>({ inbox: null, drafts: null });
  failures.current = { inbox: pairFailure(failures.current.inbox, inbox, pairSettled), drafts: pairFailure(failures.current.drafts, drafts, pairSettled) };
  const { reload: reloadInbox } = inbox;
  const { reload: reloadDrafts } = drafts;
  const { reload: reloadTotals } = totals;
  const reloadPair = useCallback(() => {
    reloadInbox();
    reloadDrafts();
    reloadTotals();
  }, [reloadInbox, reloadDrafts, reloadTotals]);
  const waitingDrafts = heldRows(drafts, inbox.loading || routeLoading, heldDrafts, failures.current.drafts, reloadPair);
  const inputs = {
    inbox: answer(heldInbox, attentionOn, (d) => d.items, COUNT_LIMITS.inbox),
    // A Drafts failure counts at once, without waiting for the Inbox: an unknown part only lowers the count to a
    // lower bound, so it can never count a decision twice; a good answer still waits for its pair.
    drafts: answer(waitingDrafts, draftsOn, (d) => d, COUNT_LIMITS.drafts),
    proposals: answer(proposals, true, (d) => d.proposals, COUNT_LIMITS.proposals),
    connections: answer(connections, true, (d) => d, null),
  };
  const count = countDecisions(countedTotals, inputs);
  // The dot remembers its last state, because an unknown part must not turn it on or off.
  const lastDot = useRef(false);
  const dot = dotAfter(lastDot.current, count.total);
  useEffect(() => {
    lastDot.current = dot;
  }, [dot]);
  const status = replication.error ? undefined : replication.data?.status;
  return {
    badges: { home: badge(count.home, WORDS.home), approvals: badge(count.approvals, WORDS.approvals), connections: badge(count.connections, WORDS.connections) },
    count,
    dot,
    inbox: inputs.inbox,
    openInbox: heldRows(inbox, drafts.loading || routeLoading, heldInbox, failures.current.inbox, reloadPair),
    drafts: inputs.drafts,
    proposals: inputs.proposals,
    waitingDrafts,
    waitingProposals: proposals,
    settingsWarning: (status && PROBLEM_WORDS[status]) ?? null,
  };
}

/**
 * One list of the pair as a screen shows it (Home's Inbox rows, Approvals' waiting Drafts): the held answer, loading
 * while either list (or, once rows show, the count route) is still asked, so a first answer from one alone never shows
 * as an empty list. Its own failure
 * (`failed`, from `pairFailure`) shows at once with its Retry, without waiting for the other list.
 */
function heldRows<R>(own: Resource<R>, otherLoading: boolean, held: Pick<Resource<R>, "data" | "error" | "answeredAt" | "askedAt">, failed: ApiError | null, reload: () => void): Resource<R> {
  return { ...own, loading: !failed && (own.loading || otherLoading), data: held.data, error: failed ?? held.error, answeredAt: held.answeredAt, askedAt: held.askedAt, reload };
}

/** The shell's signals, for the screens inside it. */
export const SignalsContext = createContext<NavSignals | null>(null);

/** The shell's count and badges, for a screen inside the shell. */
export function useSignals(): NavSignals {
  const signals = useContext(SignalsContext);
  if (!signals) throw new Error("useSignals() is for screens inside the shell");
  return signals;
}

/** The badge beside a screen's name in the navigation: Home's number moves to its Inbox heading while the owner is on Home. */
export function navBadge(signals: NavSignals, id: ScreenId, current: ScreenId | null): Badge | undefined {
  return id === "home" && current === "home" ? undefined : signals.badges[id];
}
