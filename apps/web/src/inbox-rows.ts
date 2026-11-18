import type { ActionStatus, AttentionItemView } from "@attache/contracts";
import { clockTime, sameDay, startOfDay, wallTime } from "./zoned-time.ts";

/**
 * What an Inbox row's middle and trailing columns say. The subject is the item's own words; where a connector's
 * title starts with what the kind word already says ("Review acme/web#42: ...", "Reply to Nora: ..."), the row moves
 * the repository, sender or key to the source line and keeps the rest as the subject. A title is kept whole when
 * nothing would be left, so stripping never loses what tells two items apart.
 */

const SOURCE_NAME: Readonly<Record<string, string>> = {
  vault: "Notes",
  github: "GitHub",
  jira: "Jira",
  confluence: "Confluence",
  slack: "Slack",
  gmail: "Gmail",
  gcal: "Google Calendar",
  replication: "Replication",
  replication_merge: "Replication",
};

/** Fact reviews come from the Brain's curated notes, whichever Connection read them. */
const KIND_SOURCE: Readonly<Record<string, string>> = { "fact-review": "Brain" };

type RowItem = Pick<AttentionItemView, "kind" | "sourceKind" | "title" | "summary" | "url">;

export interface RowText {
  subject: string;
  /** The source, then the sender, repository, key or note when the item names one: "GitHub · acme/web #42". */
  source: string;
}

interface Split {
  subject: string;
  context: string | null;
}

/** A title prefix and how it splits; a match whose subject is empty or a placeholder leaves the title whole. */
type Rule = (item: RowItem) => Split | null;

const GITHUB_PATH = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/;

function githubPlace(url: string | null): string | null {
  const m = url ? GITHUB_PATH.exec(url) : null;
  return m ? `${m[1]} #${m[2]}` : null;
}

function after(re: RegExp, title: string): RegExpExecArray | null {
  const m = re.exec(title);
  return m && m.at(-1)?.trim() ? m : null;
}

const RULES: Readonly<Record<string, Rule>> = {
  review_request: (i) => ({ subject: after(/^Review \S+#\d+: (.*)$/s, i.title)?.[1] ?? i.title, context: githubPlace(i.url) }),
  authored_pr: (i) => ({ subject: i.title, context: githubPlace(i.url) }),
  assigned_issue: (i) => ({ subject: i.title, context: githubPlace(i.url) }),
  pending_reply: (i) => {
    if (i.sourceKind === "slack") return slackSplit(i, /^Reply to (.+) in Slack$/s);
    if (i.sourceKind !== "gmail") return null;
    const m = after(/^Reply to (.+?): (.*)$/s, i.title);
    return m && m[2] !== "(no subject)" ? { subject: m[2]!, context: m[1]! } : null;
  },
  mention: (i) => {
    if (i.sourceKind === "slack") return slackSplit(i, /^Mentioned in (#\S+)$/s);
    if (i.sourceKind !== "confluence") return null;
    const m = after(/^Mentioned in "(.*)"$/s, i.title);
    return m ? { subject: m[1]!, context: /^(.+?) mentioned you/.exec(i.summary)?.[1] ?? null } : null;
  },
  overdue_work_item: jiraSplit,
  due_work_item: jiraSplit,
  deadline: (i) => {
    const m = after(/^(?:Overdue|Due today|Due in \d+ days?): (.*)$/s, i.title);
    return m ? { subject: m[1]!, context: /^From “(.+?)” \(/.exec(i.summary)?.[1] ?? null } : null;
  },
  invite_response: (i) => {
    const m = after(/^Respond to invite: (.*)$/s, i.title);
    return m ? { subject: m[1]!, context: null } : null;
  },
  meeting_prep: (i) => {
    const m = after(/^Prepare for (.*)$/s, i.title);
    return m ? { subject: m[1]!, context: null } : null;
  },
};

/**
 * Slack's message markup as words: `<@U1|Alex>` "@Alex", `<@U1>` "@someone", `<#C1|ops>` "#ops", `<!here>` "@here",
 * `<!subteam^S1|@team>` "@team", `<url|label>` "label", then its three escapes (`&amp;`, `&lt;`, `&gt;`) decoded.
 */
function slackText(text: string): string {
  return (text.split("\n")[0] ?? "")
    .replace(/<@[A-Z0-9]+\|([^>]+)>/g, "@$1")
    .replace(/<@[A-Z0-9]+>/g, "@someone")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<!([a-z^A-Z0-9]+)\|([^>]+)>/g, "$2")
    .replace(/<!([a-z]+)[^>]*>/g, "@$1")
    .replace(/<[^|>]+\|([^>]+)>/g, "$1")
    .replace(/<([^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

/** A Slack title only names the sender or channel, so the message is the subject and that name moves to the source line. */
function slackSplit(i: RowItem, named: RegExp): Split {
  return { subject: slackText(i.summary) || i.title, context: named.exec(i.title)?.[1] ?? null };
}

function jiraSplit(i: RowItem): Split | null {
  const m = after(/^([A-Z][A-Z0-9]*-\d+) [^:]*: (.*)$/s, i.title);
  return m ? { subject: m[2]!, context: m[1]! } : null;
}

/** "new_source" reads "New source". */
function readable(word: string): string {
  const words = word.replace(/[_-]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Unknown source";
}

/** A table's own entry, so a kind such as "constructor" never finds an inherited property. */
const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(table, key) ? table[key] : undefined);

export function rowText(item: RowItem): RowText {
  const split = own(RULES, item.kind)?.(item) ?? { subject: item.title, context: null };
  const source = own(KIND_SOURCE, item.kind) ?? own(SOURCE_NAME, item.sourceKind) ?? readable(item.sourceKind);
  return { subject: split.subject, source: split.context ? `${source} · ${split.context}` : source };
}

export interface RowTime {
  /** The instant behind the time, for `<time dateTime>`. */
  iso: string;
  /** What the trailing column shows: "08:12", "Yesterday", "Due today", "Overdue". */
  text: string;
  /** The same, in words: "Due on 21 November", "First seen at 08:12". */
  label: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The local calendar day a due value falls on, as days since the epoch: a bare date is that date wherever the owner is. */
function dueDay(dueAt: string, timeZone: string): number {
  if (DAY.test(dueAt)) return Date.parse(`${dueAt}T00:00:00Z`) / 86_400_000;
  const w = wallTime(Date.parse(dueAt), timeZone);
  return Date.UTC(w.year, w.month - 1, w.day) / 86_400_000;
}

function today(now: number, timeZone: string): number {
  const w = wallTime(now, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day) / 86_400_000;
}

const dayMonth = (day: number, month: "short" | "long") => new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month }).format(day * 86_400_000);

/** The trailing column: when it is due, if it has a due time, else when Attache first saw it. */
export function rowTime(item: Pick<AttentionItemView, "dueAt" | "firstSeenAt">, now: number, timeZone: string): RowTime {
  if (item.dueAt) {
    const day = dueDay(item.dueAt, timeZone);
    const left = day - today(now, timeZone);
    const iso = item.dueAt;
    if (left < 0) return { iso, text: "Overdue", label: `Overdue since ${dayMonth(day, "long")}` };
    if (left === 0) return { iso, text: "Due today", label: "Due today" };
    if (left === 1) return { iso, text: "Due tomorrow", label: "Due tomorrow" };
    return { iso, text: `Due ${dayMonth(day, "short")}`, label: `Due on ${dayMonth(day, "long")}` };
  }
  const at = Date.parse(item.firstSeenAt);
  const iso = item.firstSeenAt;
  if (sameDay(at, now, timeZone)) return { iso, text: clockTime(at, timeZone), label: `First seen at ${clockTime(at, timeZone)}` };
  if (startOfDay(now, timeZone, -1) === startOfDay(at, timeZone)) return { iso, text: "Yesterday", label: `First seen yesterday at ${clockTime(at, timeZone)}` };
  const local = today(at, timeZone);
  return { iso, text: dayMonth(local, "short"), label: `First seen on ${dayMonth(local, "long")}` };
}

const DRAFT_TAG: Readonly<Partial<Record<ActionStatus, string>>> = { draft: "Draft waiting", approved: "Draft approved", revoked: "Approval ended", executing: "Sending" };

/** The tag naming the state of the Draft that still stands for an item (one in `OPEN_ACTION_STATUSES`), else null. */
export function draftTag(status: ActionStatus | null): string | null {
  return status ? (DRAFT_TAG[status] ?? null) : null;
}

/** When Snooze can bring an item back: in an hour, tomorrow at 09:00, next Monday at 09:00, in the browser's local time. */
export function snoozeChoices(now: Date): Array<{ label: string; iso: string }> {
  const at = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 9, 0);
  const toMonday = (8 - now.getDay()) % 7 || 7;
  return [
    { label: "1 hour", iso: new Date(now.getTime() + 3_600_000).toISOString() },
    { label: "Tomorrow 09:00", iso: at(1).toISOString() },
    { label: "Next Monday", iso: at(toMonday).toISOString() },
  ];
}

/** When a snooze ends, against `now`: "11:30" today, "tomorrow 09:00", or "23 Nov 09:00". */
export function untilText(iso: string, now: number, timeZone: string): string {
  const at = Date.parse(iso);
  const clock = clockTime(at, timeZone);
  if (sameDay(at, now, timeZone)) return clock;
  if (startOfDay(now, timeZone, 1) === startOfDay(at, timeZone)) return `tomorrow ${clock}`;
  return `${dayMonth(today(at, timeZone), "short")} ${clock}`;
}
