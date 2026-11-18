import { plural, WAITING_ACTION_STATUSES, type ActionView, type AttentionItemView, type ConnectionStatus, type ProposalView, type ReplicationStatus, type ReplicationView } from "@attache/contracts";
import { useResource, type Resource } from "./live.ts";
import type { ScreenId } from "./routes.ts";

/**
 * What the navigation shows beside a screen's name: the decisions waiting there, and the named Replication
 * warning on Settings. The shell reads only `useNavSignals()`; the count module (#19 of spec #14) replaces how
 * the numbers are worked out without touching the masthead, the bottom bar or the More sheet.
 */

/** A number beside a screen's name, and what a screen reader hears after the name: "Approvals, 2 waiting". */
export interface Badge {
  count: number;
  /** The number with what it counts: "2 waiting", "1 needs you", "1 sign-in needed". */
  label: string;
}

export interface NavSignals {
  badges: Partial<Record<ScreenId, Badge>>;
  /** Every decision that waits: what the logo's dot follows. */
  total: number;
  /** "Replication blocked" or "Replication unauthorized" while it is; null otherwise. */
  settingsWarning: string | null;
}

const WAITING = new Set<string>(WAITING_ACTION_STATUSES);

/** A list the owner can read now: null while it loads, after it failed, or when its feature is off. */
function known<T>(r: Resource<T>): T | null {
  return r.error ? null : r.data;
}

function badge(count: number | null, label: (n: number) => string): Badge | undefined {
  return count ? { count, label: label(count) } : undefined;
}

const PROBLEM_WORDS: Partial<Record<ReplicationStatus, string>> = { blocked: "Replication blocked", unauthorized: "Replication unauthorized" };

export function useNavSignals(): NavSignals {
  const inbox = useResource<{ items: AttentionItemView[] }>("/attention", ["attention.changed", "actions.changed"]);
  const drafts = useResource<ActionView[]>(`/actions?status=${WAITING_ACTION_STATUSES.join(",")}`, ["actions.changed"]);
  const proposals = useResource<{ proposals: ProposalView[] }>("/memory/proposals?status=proposed", ["memory.changed"]);
  const connections = useResource<ConnectionStatus[]>("/connections", ["connections.changed"]);
  const replication = useResource<ReplicationView>("/replication", ["replication.changed", "config.changed"]);

  // An Inbox item whose Draft waits is decided in Approvals, so it counts there and not on Home.
  const items = known(inbox)?.items.filter((i) => !(i.actionStatus && WAITING.has(i.actionStatus)));
  const home = items ? items.length : null;
  const waitingDrafts = known(drafts)?.length ?? null;
  const waitingProposals = known(proposals)?.proposals.length ?? null;
  const approvals = waitingDrafts === null && waitingProposals === null ? null : (waitingDrafts ?? 0) + (waitingProposals ?? 0);
  const signIns = known(connections)?.filter((c) => c.status === "needs_auth").length ?? null;
  const status = known(replication)?.status;
  return {
    badges: {
      home: badge(home, (n) => plural(n, "needs you", "need you")),
      approvals: badge(approvals, (n) => `${n} waiting`),
      connections: badge(signIns, (n) => `${plural(n, "sign-in")} needed`),
    },
    total: (home ?? 0) + (approvals ?? 0) + (signIns ?? 0),
    settingsWarning: (status && PROBLEM_WORDS[status]) ?? null,
  };
}

/** The badge beside a screen's name in the navigation: Home's number moves to its Inbox heading while the owner is on Home. */
export function navBadge(signals: NavSignals, id: ScreenId, current: ScreenId | null): Badge | undefined {
  return id === "home" && current === "home" ? undefined : signals.badges[id];
}
