import { plural } from "@attache/contracts";
import { nameList, type ConnectionsStatus } from "./connection-status.ts";
import type { DecisionCount, Tally } from "./count.ts";
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

export interface EmptyInboxInput {
  count: DecisionCount;
  reach: InboxReach;
  /** How many open items For you now shows above as meeting prep (they are not listed here). */
  above: number;
  /** A request behind the count failed (as opposed to not having answered yet). */
  failed: boolean;
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

const MEETINGS_ABOVE = "The meeting prep above is open. Not now brings it back here.";

const line = (text: string, link: EmptyLine["link"] = null): EmptyLine => ({ text, link });

/** "5 sources", "the one source". */
const sourcesRead = (n: number | null) => (n === null ? "the sources that were read" : n === 1 ? "the one source that was read" : `the ${n} sources that were read`);

function title(reach: InboxReach, clear: boolean, above: boolean): string {
  if (clear) return "Nothing needs you.";
  const found = above ? "Nothing else found" : "Nothing found";
  if (reach.kind === "partial") return `${found} in ${sourcesRead(reach.sources)}.`;
  if (reach.kind === "notes") return `${found} in your notes.`;
  if (above) return reach.kind === "all" ? "Nothing else needs your attention." : "No other open Inbox items.";
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
    lines.push(line(`${n} ${approvals.count === 1 && approvals.exact ? "waits on its" : "wait on their"} own page.`, "approvals"));
  }
  if (connections.count > 0) lines.push(line(connections.count === 1 ? "A Connection needs your sign-in, above." : `${connections.count} Connections need your sign-in, above.`));
  return lines;
}

const uncounted = (t: Tally) => !t.exact && t.count === 0;

/**
 * The empty Inbox's words, or null while a part of the count has not answered yet (the view keeps loading: a
 * moment's "No open Inbox items." before "Nothing needs you." would be a claim taken back).
 */
export function emptyInbox({ count, reach, above, failed, now, timeZone }: EmptyInboxInput): EmptyInbox | null {
  const missing = [count.approvals.count === 0 && !count.approvals.exact && "approvals", uncounted(count.connections) && "sign-ins"].filter((p): p is string => Boolean(p));
  const homeUncounted = !count.home.exact && count.home.count === 0;
  if ((missing.length || homeUncounted) && !failed) return null;
  const clear = count.total.exact && count.total.count === 0 && reach.kind === "all";
  const lines: EmptyLine[] = [];
  if (above > 0) lines.push(line(MEETINGS_ABOVE));
  lines.push(line(readLine(reach, now, timeZone)));
  lines.push(...waitLines(count));
  if (missing.length) {
    const what = nameList(missing);
    lines.push(line(`${what[0]!.toUpperCase()}${what.slice(1)} could not be counted, so Attache cannot say that nothing needs you.`));
  }
  return { title: title(reach, clear, above > 0), clear, lines, retry: failed && missing.length > 0 };
}
