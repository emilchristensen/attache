import { plural } from "@attache/contracts";
import { nameList, type ConnectionsStatus } from "./connection-status.ts";
import type { DecisionCount } from "./count.ts";
import { spokenTime } from "./zoned-time.ts";

/**
 * What an empty Inbox says (pure, table tests in `apps/web/test/inbox-empty.test.ts`). It claims no more than is
 * known: what was read comes from Home's Connections area, what still waits elsewhere from the decision count.
 * "Nothing needs you." is said only from an exact zero with every source read; a source not read, notes only, or a
 * part of the count that could not be counted each change the words. The rules are in
 * `docs/design/dashboard-redesign/fable/spec-dot-and-drafts.md`, part 1.6.
 */

/** What the Inbox's sources reached, as Home's Connections area says. */
export type InboxReach =
  /** Every source that can raise an Inbox item was read. `sources`: how many (null when not known). */
  | { kind: "all"; sources: number | null; lastReadAt: string | null }
  /** No work source is connected: only the notes were read. */
  | { kind: "notes" }
  /** Some sources were not read; `sources` were (null when not known). */
  | { kind: "partial"; sources: number | null; missing: ReadonlyArray<{ subject: string; word: string }> }
  /** The area is still checking, or could not check: nothing is known about what was read. */
  | { kind: "unknown"; checking: boolean };

export function inboxReach(status: ConnectionsStatus): InboxReach {
  if (status.kind === "all_good") return { kind: "all", sources: status.sources, lastReadAt: status.lastReadAt };
  const pending = status.rows.find((r) => r.state === "checking" || r.state === "could_not_check");
  if (pending) return { kind: "unknown", checking: pending.state === "checking" };
  const missing = status.rows.filter((r) => r.inbox);
  const sources = status.working?.sources ?? null;
  if (!missing.length) return { kind: "all", sources, lastReadAt: null };
  if (missing.every((r) => r.state === "notes_only")) return { kind: "notes" };
  return { kind: "partial", sources, missing: missing.filter((r) => r.state !== "notes_only").map((r) => ({ subject: r.subject, word: r.word })) };
}

/** Which parts of the decision count a failed request left inexact (`NavSignals.countFailures`). */
export interface CountFailures {
  approvals: boolean;
  signIns: boolean;
}

export interface EmptyInboxInput {
  count: DecisionCount;
  reach: InboxReach;
  /** The parts a failed request left inexact (as opposed to not having answered yet). */
  failed: CountFailures;
  now: number;
  timeZone: string;
}

/** One sentence under the title; `approvals` links to the Approvals page. */
export interface EmptyLine {
  text: string;
  link: "approvals" | null;
}

export interface EmptyInbox {
  title: string;
  /** "Nothing needs you.": the logo without its dot stands beside the words. */
  clear: boolean;
  lines: EmptyLine[];
  /** A count request failed: Retry asks again. */
  retry: boolean;
}

const line = (text: string, link: EmptyLine["link"] = null): EmptyLine => ({ text, link });

/** "the 5 sources that were read", "the one source that was read". */
const sourcesRead = (n: number) => (n === 1 ? "the one source that was read" : `the ${n} sources that were read`);

/**
 * The title claims what was found only where something is known to have been read; otherwise it speaks of the list
 * alone. With meeting prep above, "Nothing else needs your attention." also needs nothing waiting anywhere else.
 */
function title(reach: InboxReach, clear: boolean, above: boolean, elsewhere: boolean): string {
  if (clear) return "Nothing needs you.";
  const found = above ? "Nothing else found" : "Nothing found";
  if (reach.kind === "partial" && reach.sources) return `${found} in ${sourcesRead(reach.sources)}.`;
  if (reach.kind === "notes") return `${found} in your notes.`;
  if (above) return reach.kind === "all" && !elsewhere ? "Nothing else needs your attention." : "No other open Inbox items.";
  return "No open Inbox items.";
}

function readLine(reach: InboxReach, now: number, timeZone: string): string {
  switch (reach.kind) {
    case "all": {
      const who = reach.sources === null ? "Every source was read" : reach.sources === 1 ? "Your one source was read" : `All ${reach.sources} sources were read`;
      const at = reach.lastReadAt === null ? null : Date.parse(reach.lastReadAt);
      return at === null || !Number.isFinite(at) ? `${who}.` : `${who}, last ${spokenTime(at, now, timeZone)}.`;
    }
    case "notes":
      return "No work source is connected, so only your notes were read.";
    case "partial":
      return `Not read: ${nameList(reach.missing.map((m) => `${m.subject} (${m.word.toLowerCase()})`))}.`;
    case "unknown":
      return reach.checking ? "Connections are still being checked, so Attache cannot say yet what was read." : "Connections could not be checked, so Attache cannot say what was read.";
  }
}

/** "4 approvals wait on their own page.", "At least 100 ...": a part of the count known to hold something. */
function waitLines(count: DecisionCount): EmptyLine[] {
  const lines: EmptyLine[] = [];
  const { approvals, connections } = count;
  if (approvals.count > 0) {
    const n = `${approvals.exact ? "" : "At least "}${plural(approvals.count, "approval")}`;
    lines.push(line(`${n} ${approvals.count === 1 ? "waits on its" : "wait on their"} own page.`, "approvals"));
  }
  if (connections.count > 0) lines.push(line(connections.count === 1 ? "A Connection needs your sign-in, above." : `${connections.count} Connections need your sign-in, above.`));
  return lines;
}

const PARTS = [
  { key: "approvals", name: "approvals" },
  { key: "signIns", name: "sign-ins" },
] as const;

const capital = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}`;

/**
 * The empty Inbox's words, or null while a part of the count is still being asked (the view keeps loading: a
 * moment's "No open Inbox items." before "Nothing needs you." would be a claim taken back). A part a failed request
 * left inexact is named: as not counted when nothing of it is known, as not all counted beside a lower bound.
 */
export function emptyInbox({ count, reach, failed, now, timeZone }: EmptyInboxInput): EmptyInbox | null {
  const tally = { approvals: count.approvals, signIns: count.connections };
  // Nothing known of a part, and no failure behind it: it is still being asked.
  const asking = PARTS.some((p) => !tally[p.key].exact && tally[p.key].count === 0 && !failed[p.key]);
  if (asking || (!count.home.exact && count.home.count === 0)) return null;
  const clear = count.total.exact && count.total.count === 0 && reach.kind === "all";
  const elsewhere = [count.approvals, count.connections].some((t) => t.count > 0 || !t.exact);
  const lines: EmptyLine[] = [];
  lines.push(line(readLine(reach, now, timeZone)));
  lines.push(...waitLines(count));
  const lost = PARTS.filter((p) => failed[p.key] && !tally[p.key].exact);
  const none = lost.filter((p) => tally[p.key].count === 0).map((p) => p.name);
  const some = lost.filter((p) => tally[p.key].count > 0).map((p) => p.name);
  if (none.length) lines.push(line(`${capital(nameList(none))} could not be counted, so Attache cannot say that nothing needs you.`));
  if (some.length) lines.push(line(`${capital(nameList(some))} could not all be counted.`));
  const retry = lost.length > 0;
  return { title: title(reach, clear, false, elsewhere), clear, lines, retry };
}
