import { plural, type ConnectionKind, type ConnectionStatus, type CoverageState, type FeatureStatus, type ReaderView } from "@attache/contracts";

/**
 * The Connections area on Home: one pure decision from the three answers the Dashboard already asks for
 * (`/connections`, the features in `/capabilities` and `/reader`) to either the green "All good" line or one row
 * per problem. It claims no more than those answers establish: green only when all three arrived and everything is
 * healthy, last-read times only from stored success times, and a retry time only when one is really scheduled.
 */

/** One request's answer: still waiting, failed, or arrived. */
export type Reply<T> = { state: "waiting" } | { state: "failed"; message?: string } | { state: "ok"; data: T };

export interface StatusInputs {
  connections: Reply<ConnectionStatus[]>;
  features: Reply<FeatureStatus[]>;
  reader: Reply<ReaderView>;
  /** When this Machine's Source refresh schedule runs next (`/schedules`); null when it is off or unknown. */
  nextRefreshAt: string | null;
}

export type StatusState =
  | "sign_in"
  | "switched_off"
  | "not_reading"
  | "down"
  | "offline"
  | "denied"
  | "partial"
  | "partly_working"
  | "needs_setup"
  | "cannot_run"
  | "not_read_yet"
  | "notes_only"
  | "checking"
  | "could_not_check";

/** The one button a row may have. */
export type StatusAction =
  | { kind: "reconnect"; connectionId: string }
  | { kind: "refresh"; connectionIds: string[]; label: "Retry now" | "Refresh now" }
  | { kind: "retry_check" }
  | { kind: "open_connections"; connectionId?: string }
  | { kind: "open_settings" }
  | { kind: "machines" };

export interface StatusRow {
  /** Stable across answers: the state and what it is about. */
  key: string;
  state: StatusState;
  /** The visible state word: "Sign-in needed". */
  word: string;
  /** Amber: the owner can act, or part was read. Red: nothing was read, or it cannot run. Slate: nothing is known. */
  hue: "amber" | "red" | "slate";
  icon: "key" | "warning" | "question" | "brain" | "settings";
  /** What it is about: "Gmail", "GitHub, Gmail and Slack", "Drafts and approvals", "Home PC". */
  subject: string;
  /** The short impact that stays on the collapsed line: "Replies may be missing". */
  impact: string;
  /** One sentence saying what may be missing from the Inbox, or what waits. */
  sentence: string;
  /** The service's own words for what went wrong, when it gave any. */
  failure: string | null;
  /** When each affected source was last read, only from stored success times; empty when nothing is read. */
  lastRead: Array<{ name: string; at: string | null }>;
  /** `at`: the next automatic read is scheduled; `none`: nothing reads it again by itself; null: nothing to promise. */
  retry: { kind: "at"; at: string } | { kind: "none" } | null;
  action: StatusAction | null;
  /** This row is a decision behind the logo's dot: only a Connection in `needs_auth`. */
  counted: boolean;
}

export type ConnectionsStatus =
  | { kind: "all_good"; sources: number; others: number; lastReadAt: string | null; reader: string }
  | { kind: "problems"; rows: StatusRow[]; working: { sources: number; others: number } | null };

/** How many problem rows show before the rest go behind "N more". */
export const MAX_ROWS = 3;

/** The sources a Source refresh reads, as the service's capability registry lists them. */
const READABLE: readonly ConnectionKind[] = ["vault", "github", "jira", "confluence", "slack", "gmail", "gcal"];

/** What may be missing from the Inbox when a source is not read: the short words for the collapsed line, and the whole phrase. */
const MISSING: Partial<Record<ConnectionKind, { short: string; long: string }>> = {
  vault: { short: "Deadlines may be missing", long: "deadlines and facts to check from your notes" },
  github: { short: "Reviews may be missing", long: "GitHub reviews, pull requests and assigned issues" },
  jira: { short: "Work items may be missing", long: "Jira work items" },
  confluence: { short: "Mentions may be missing", long: "Confluence mentions" },
  slack: { short: "Replies and mentions may be missing", long: "Slack replies and mentions" },
  gmail: { short: "Replies may be missing", long: "Gmail replies" },
  gcal: { short: "Meetings may be missing", long: "meetings and invites" },
};

const ORDER: StatusState[] = ["sign_in", "switched_off", "not_reading", "down", "offline", "denied", "partial", "partly_working", "needs_setup", "cannot_run", "not_read_yet", "notes_only"];

const REQUEST_NAME: Record<keyof Omit<StatusInputs, "nextRefreshAt">, string> = { connections: "the list of Connections", features: "the feature list", reader: "the Reader" };

const REQUEST_SUBJECT: Record<keyof Omit<StatusInputs, "nextRefreshAt">, string> = { connections: "Connections", features: "Features", reader: "Reader" };

const HEALTHY_COVERAGE: ReadonlySet<CoverageState> = new Set(["complete", "empty"]);

/** "GitHub", "GitHub and Slack", "GitHub, Gmail and Slack". */
export function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function isReadable(c: ConnectionStatus): boolean {
  return READABLE.includes(c.kind);
}

/** Set up and meant to work: neither waiting to be set up nor disconnected by the owner. */
function inUse(c: ConnectionStatus): boolean {
  return c.status !== "not_configured" && c.status !== "disconnected";
}

function missingPhrase(c: ConnectionStatus): string {
  return MISSING[c.kind]?.long ?? `items from ${c.label}`;
}

/** A coverage state, raised to the worst state of any of its scopes: a refused or partial scope shows even when the rest was read. */
function coverageState(c: ConnectionStatus): CoverageState | null {
  const cov = c.coverage;
  if (!cov) return null;
  if (!HEALTHY_COVERAGE.has(cov.state)) return cov.state;
  for (const worse of ["unauthorized", "denied", "partial"] as const) {
    if (cov.scopes.some((s) => s.state === worse)) return worse;
  }
  return cov.state;
}

function coverageNote(c: ConnectionStatus, state: CoverageState): string | null {
  const scopes = c.coverage?.scopes.filter((s) => s.state === state) ?? [];
  if (state === "denied" && scopes.length) return `Refused: ${scopes.map((s) => s.scope).join(", ")}`;
  return c.coverage?.note ?? scopes.find((s) => s.note)?.note ?? c.lastError ?? null;
}

interface Context {
  /** The Reader reads on a schedule: a Machine holds the role and is not silent, and Attention and briefings is on. */
  reading: boolean;
  /** The next automatic read, only when this Machine is that active Reader and its schedule says when. */
  nextReadAt: string | null;
}

function retryOf(ctx: Context): StatusRow["retry"] {
  if (!ctx.reading) return { kind: "none" };
  return ctx.nextReadAt ? { kind: "at", at: ctx.nextReadAt } : null;
}

function lastReadOf(cs: ConnectionStatus[]): StatusRow["lastRead"] {
  return cs.filter(isReadable).map((c) => ({ name: c.label, at: c.lastSuccessAt }));
}

const BASE: Pick<StatusRow, "failure" | "lastRead" | "retry" | "counted"> = { failure: null, lastRead: [], retry: null, counted: false };

function signInRow(c: ConnectionStatus): StatusRow {
  const source = isReadable(c);
  const impact = source ? (MISSING[c.kind]?.short ?? "Items may be missing") : c.kind === "model" ? "Briefings and new Drafts wait" : "Its saves may not arrive";
  const sentence = source
    ? `${c.label} signed you out, so ${missingPhrase(c)} may be missing below.`
    : c.kind === "model"
      ? "The model is signed out, so briefings, new Drafts and Consolidation wait until you sign in. Sources are still read."
      : `${c.label} is signed out, so what it saves may not reach the Brain.`;
  return {
    ...BASE,
    key: `sign_in:${c.id}`,
    state: "sign_in",
    word: "Sign-in needed",
    hue: "amber",
    icon: "key",
    subject: c.label,
    impact,
    sentence,
    failure: c.lastError,
    lastRead: lastReadOf([c]),
    action: { kind: "reconnect", connectionId: c.id },
    counted: c.status === "needs_auth",
  };
}

function downRow(c: ConnectionStatus, ctx: Context): StatusRow {
  const source = isReadable(c);
  return {
    ...BASE,
    key: `down:${c.id}`,
    state: "down",
    word: "Down",
    hue: "red",
    icon: "warning",
    subject: c.label,
    impact: source ? (MISSING[c.kind]?.short ?? "Items may be missing") : "It does not work",
    sentence: source ? `${c.label} is not answering, so ${missingPhrase(c)} may be missing below.` : `${c.label} does not answer.`,
    failure: c.status === "error" ? c.lastError : coverageNote(c, "error"),
    lastRead: lastReadOf([c]),
    retry: source ? retryOf(ctx) : null,
    action: source ? { kind: "refresh", connectionIds: [c.id], label: "Retry now" } : { kind: "open_connections", connectionId: c.id },
  };
}

function offlineRow(cs: ConnectionStatus[], ctx: Context): StatusRow {
  const one = cs.length === 1 ? cs[0]! : null;
  return {
    ...BASE,
    key: `offline:${cs.map((c) => c.id).join(",")}`,
    state: "offline",
    word: "Offline",
    hue: "red",
    icon: "warning",
    subject: nameList(cs.map((c) => c.label)),
    impact: one ? (MISSING[one.kind]?.short ?? "Items may be missing") : "Their items may be missing",
    sentence: one
      ? `This Machine had no network, so ${one.label} was not read and ${missingPhrase(one)} may be missing below.`
      : `This Machine had no network, so ${plural(cs.length, "source")} were not read and their items may be missing below.`,
    lastRead: lastReadOf(cs),
    retry: retryOf(ctx),
    action: { kind: "refresh", connectionIds: cs.map((c) => c.id), label: "Retry now" },
  };
}

function coverageRow(c: ConnectionStatus, state: "denied" | "partial"): StatusRow {
  const denied = state === "denied";
  return {
    ...BASE,
    key: `${state}:${c.id}`,
    state,
    word: denied ? "Access denied" : "Partly read",
    hue: "amber",
    icon: denied ? "key" : "warning",
    subject: c.label,
    impact: MISSING[c.kind]?.short ?? "Items may be missing",
    sentence: denied ? `${c.label} refused one of the reads, so ${missingPhrase(c)} may be missing below.` : `${c.label} was only partly read, so ${missingPhrase(c)} may be missing below.`,
    failure: coverageNote(c, state),
    lastRead: lastReadOf([c]),
    action: { kind: "open_connections", connectionId: c.id },
  };
}

function notReadYetRow(cs: ConnectionStatus[], ctx: Context): StatusRow {
  const one = cs.length === 1 ? cs[0]! : null;
  return {
    ...BASE,
    key: `not_read_yet:${cs.map((c) => c.id).join(",")}`,
    state: "not_read_yet",
    word: "Not read yet",
    hue: "slate",
    icon: "question",
    subject: nameList(cs.map((c) => c.label)),
    impact: one ? (MISSING[one.kind]?.short ?? "Items may be missing") : "Their items may be missing",
    sentence: one ? `No Source refresh has finished for ${one.label} yet, so ${missingPhrase(one)} may be missing below.` : `No Source refresh has finished for ${plural(cs.length, "source")} yet, so their items may be missing below.`,
    lastRead: lastReadOf(cs),
    retry: retryOf(ctx),
    action: { kind: "refresh", connectionIds: cs.map((c) => c.id), label: "Refresh now" },
  };
}

function featureRow(f: FeatureStatus): StatusRow | null {
  if (!f.enabled || f.readiness === "ready" || f.readiness === "disabled") return null;
  const state = f.readiness === "partial" ? "partly_working" : f.readiness === "needs_setup" ? "needs_setup" : "cannot_run";
  const words = { partly_working: ["Partly working", "Part of it works"], needs_setup: ["Needs setup", "It does not run yet"], cannot_run: ["Cannot run", "It cannot run"] } as const;
  return {
    ...BASE,
    key: `${state}:${f.id}`,
    state,
    word: words[state][0],
    hue: state === "cannot_run" ? "red" : "amber",
    icon: state === "cannot_run" ? "warning" : "key",
    subject: f.label,
    impact: words[state][1],
    sentence: f.reason ?? `${f.label} is not ready.`,
    action: { kind: "open_settings" },
  };
}

function notReadingRow(r: ReaderView): StatusRow {
  const name = r.machine ? (r.thisMachine ? "This Machine" : r.machine.name) : "No Machine";
  return {
    ...BASE,
    key: "not_reading",
    state: "not_reading",
    word: "Not reading",
    hue: "red",
    icon: "warning",
    subject: name,
    impact: "New items may be missing",
    sentence: r.machine
      ? `${name}, the Reader, went silent, so no Machine reads the sources and new items may be missing below.`
      : "No Machine is the Reader yet, so no Machine reads the sources and new items may be missing below.",
    lastRead: [{ name: "Every source", at: r.lastRefreshAt }],
    retry: { kind: "none" },
    action: { kind: "machines" },
  };
}

const SWITCHED_OFF: StatusRow = {
  ...BASE,
  key: "switched_off",
  state: "switched_off",
  word: "Switched off",
  hue: "slate",
  icon: "settings",
  subject: "Attention and briefings",
  impact: "Sources are not read",
  sentence: "Sources are not read for the Inbox and no briefing is made. Search, Proposals and Drafts still work.",
  action: { kind: "open_settings" },
};

const NOTES_ONLY: StatusRow = {
  ...BASE,
  key: "notes_only",
  state: "notes_only",
  word: "Notes only",
  hue: "slate",
  icon: "brain",
  subject: "Notes",
  impact: "Only your notes are read",
  sentence: "No work source is connected, so the Inbox holds only deadlines and facts from your notes.",
  action: { kind: "open_connections" },
};

/** The rows that come from one Connection's status and its last read. Reading problems drop out while nothing reads. */
function connectionRows(cs: ConnectionStatus[], ctx: Context, attentionOn: boolean): { rows: StatusRow[]; healthy: ConnectionStatus[] } {
  const rows: StatusRow[] = [];
  const healthy: ConnectionStatus[] = [];
  const offline: ConnectionStatus[] = [];
  const unread: ConnectionStatus[] = [];
  for (const c of cs.filter(inUse)) {
    if (c.status === "needs_auth") rows.push(signInRow(c));
    else if (c.status === "error") rows.push(downRow(c, ctx));
    else if (!isReadable(c)) healthy.push(c);
    else if (!attentionOn) continue;
    else {
      const state = coverageState(c);
      if (state === null || state === "never_run" || state === "not_configured") unread.push(c);
      else if (state === "unauthorized") rows.push(signInRow(c));
      else if (state === "error") rows.push(downRow(c, ctx));
      else if (state === "offline") offline.push(c);
      else if (state === "denied" || state === "partial") rows.push(coverageRow(c, state));
      else healthy.push(c);
    }
  }
  if (offline.length) rows.push(offlineRow(offline, ctx));
  if (unread.length) rows.push(notReadYetRow(unread, ctx));
  return { rows, healthy };
}

function waitingOrFailed(i: StatusInputs): StatusRow | null {
  const keys = ["connections", "features", "reader"] as const;
  const failed = keys.filter((k) => i[k].state === "failed");
  if (failed.length) {
    const first = i[failed[0]!];
    return {
      ...BASE,
      key: "could_not_check",
      state: "could_not_check",
      word: "Could not check",
      hue: "slate",
      icon: "question",
      subject: nameList(failed.map((k) => REQUEST_SUBJECT[k])),
      impact: "Items may be missing",
      sentence: `Asking for ${nameList(failed.map((k) => REQUEST_NAME[k]))} failed, so Attache cannot say which Connections work and items may be missing below.`,
      failure: first.state === "failed" ? (first.message ?? null) : null,
      action: { kind: "retry_check" },
    };
  }
  if (keys.some((k) => i[k].state === "waiting")) {
    return { ...BASE, key: "checking", state: "checking", word: "Checking", hue: "slate", icon: "question", subject: "Every Connection", impact: "Nothing is known yet", sentence: "Checking your Connections.", action: null };
  }
  return null;
}

export function connectionsStatus(i: StatusInputs): ConnectionsStatus {
  const pending = waitingOrFailed(i);
  if (pending || i.connections.state !== "ok" || i.features.state !== "ok" || i.reader.state !== "ok") {
    return { kind: "problems", rows: pending ? [pending] : [], working: null };
  }
  const connections = i.connections.data;
  const features = i.features.data;
  const reader = i.reader.data;
  const attentionOn = features.find((f) => f.id === "attention")?.enabled ?? false;
  const readerActive = reader.machine !== null && !reader.silent;
  const ctx: Context = { reading: readerActive && attentionOn, nextReadAt: readerActive && attentionOn && reader.thisMachine ? i.nextRefreshAt : null };

  const { rows, healthy } = connectionRows(connections, ctx, attentionOn);
  if (!attentionOn) rows.push(SWITCHED_OFF);
  else if (!readerActive) rows.push(notReadingRow(reader));
  for (const f of features) {
    const row = featureRow(f);
    if (row) rows.push(row);
  }
  const workSources = connections.filter((c) => inUse(c) && isReadable(c) && c.kind !== "vault");
  if (attentionOn && workSources.length === 0) rows.push(NOTES_ONLY);

  const sources = healthy.filter(isReadable).length;
  const others = healthy.length - sources;
  if (rows.length === 0) return { kind: "all_good", sources, others, lastReadAt: reader.lastRefreshAt, reader: reader.thisMachine ? "This Machine" : (reader.machine?.name ?? "") };
  const sorted = [...rows].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state));
  return { kind: "problems", rows: sorted, working: ctx.reading ? { sources, others } : null };
}

/**
 * What an empty Inbox may claim: `all` sources were read, only the `notes` were (no work source is connected), or
 * the list is `incomplete` because the area shows a problem or does not know yet.
 */
export type InboxCoverage = "all" | "notes" | "incomplete";

export function inboxCoverage(status: ConnectionsStatus): InboxCoverage {
  if (status.kind === "all_good") return "all";
  return status.rows.length > 0 && status.rows.every((r) => r.state === "notes_only") ? "notes" : "incomplete";
}

/** The rows that show, and the rest behind one "N more" disclosure. */
export function splitRows(rows: StatusRow[]): { shown: StatusRow[]; more: StatusRow[] } {
  return { shown: rows.slice(0, MAX_ROWS), more: rows.slice(MAX_ROWS) };
}

/** "1 more: not read yet", "2 more: down and not read yet". */
export function moreLabel(more: StatusRow[]): string {
  const words = [...new Set(more.map((r) => r.word.toLowerCase()))];
  return `${more.length} more: ${nameList(words)}`;
}
