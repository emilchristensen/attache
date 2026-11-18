import { createContext, useCallback, useContext, useEffect, useRef } from "react";
import { WAITING_ACTION_STATUSES, type ActionView, type AttentionItemView, type ConnectionStatus, type ProposalView, type ReplicationStatus, type ReplicationView } from "@attache/contracts";
import { countDecisions, dotAfter, shownCount, spokenCount, type Answer, type DecisionCount, type Tally } from "./count.ts";
import { useResource, type Resource } from "./live.ts";
import type { ScreenId } from "./routes.ts";

/**
 * What the navigation shows beside a screen's name: the decisions waiting there (from the count in `count.ts`), and
 * the named Replication warning on Settings. The shell asks for the lists once, in `useNavSignals()`, and shares the
 * answer with the screens through `useSignals()`, so the masthead, the bottom bar, More, the logo, the favicon, the
 * tab title and Home's Inbox heading all show one count.
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
  /** The rows behind `inbox`, as the count holds them: Home lists these, and its Retry asks the Inbox and Drafts again. */
  openInbox: Resource<{ items: AttentionItemView[] }>;
  /** "Replication blocked" or "Replication unauthorized" while it is; null otherwise. */
  settingsWarning: string | null;
}

/** The list limits the count asks for; a full answer makes its part a lower bound ("N+") until #20's count route. */
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

/** Asks the lists behind the count. Called once, by the shell; screens read the result with `useSignals()`. */
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
  const connections = useResource<ConnectionStatus[]>("/connections", ["connections.changed"]);
  const replication = useResource<ReplicationView>("/replication", ["replication.changed", "config.changed"]);

  // An Inbox item and its Draft are one decision, counted on Home or in Approvals by the item's Draft status. The two
  // lists are always asked together (the same live events, and one Retry for both), and a new answer from one is
  // held until the other has answered too; otherwise the count would show the decision twice, or not at all, for as
  // long as the slower request takes. Home's rows come from the same held answer, so they match the count.
  const settled = useRef({ inbox: { data: inbox.data, error: inbox.error }, drafts: { data: drafts.data, error: drafts.error } });
  if (!inbox.loading && !drafts.loading) settled.current = { inbox: { data: inbox.data, error: inbox.error }, drafts: { data: drafts.data, error: drafts.error } };
  const { inbox: heldInbox, drafts: heldDrafts } = settled.current;
  const { reload: reloadInbox } = inbox;
  const { reload: reloadDrafts } = drafts;
  const reloadPair = useCallback(() => {
    reloadInbox();
    reloadDrafts();
  }, [reloadInbox, reloadDrafts]);
  const inputs = {
    inbox: answer(heldInbox, attentionOn, (d) => d.items, COUNT_LIMITS.inbox),
    drafts: answer(heldDrafts, draftsOn, (d) => d, COUNT_LIMITS.drafts),
    proposals: answer(proposals, true, (d) => d.proposals, COUNT_LIMITS.proposals),
    connections: answer(connections, true, (d) => d, null),
  };
  const count = countDecisions(inputs);
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
    openInbox: homeRows(inbox, drafts.loading, heldInbox, reloadPair),
    settingsWarning: (status && PROBLEM_WORDS[status]) ?? null,
  };
}

/**
 * Home's rows: the held Inbox answer, loading while either list of the pair is still asked, so a first answer from
 * the Inbox alone never shows as an empty list. An Inbox failure shows at once with its Retry, without waiting for
 * Drafts; the count still waits for the pair.
 */
function homeRows<R>(inbox: Resource<R>, draftsLoading: boolean, held: Pick<Resource<R>, "data" | "error">, reload: () => void): Resource<R> {
  const failed = !inbox.loading && inbox.error ? inbox.error : null;
  return { ...inbox, loading: !failed && (inbox.loading || draftsLoading), data: held.data, error: failed ?? held.error, reload };
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
