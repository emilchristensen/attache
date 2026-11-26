/**
 * The line under the masthead about Attache itself (spec #130, "Dashboard"): in the same full-width place as the
 * Connection banner, after it when both show. It shows one of:
 * - "Attache updated to 0.7.0 · What changed", for one day after an Update;
 * - "Attache 0.7.0 is ready · Install", in Ask first;
 * - "Attache 0.7.0 is waiting for 2 Jobs to finish · Restart now";
 * - "Installing Attache 0.7.0", while the installer runs, so the line pressed Install on says what happens now;
 * - "The Update to 0.7.0 failed, so Attache went back to 0.6.1 · Details", for one day after a rollback;
 * - "Update this Machine to keep replicating", while Replication is paused because the Brain is in a Brain format this
 *   Machine's Attache cannot read (#143, ADR 0008). Its action is the way to that Update: Install or Restart now once
 *   one waits, otherwise Details in Settings' Updates section, which also tells when Updates are Off.
 * None of them counts toward the Decision count or turns on the Attention dot: they are not decisions.
 *
 * Pure, so every state has a table test (`test/update-line.test.ts`). `LINES` holds the rules in the order they win:
 * what waits for the owner or happens now comes before news of the last Update.
 * A later line adds its input to `UpdateLineInput`, its state and action to the unions below, and one rule to `LINES`
 * where it ranks; `components/UpdateLine.tsx` renders any rule's line.
 */
import { plural, type LastUpdateView, type ReplicationView, type UpdatesView } from "@attache/contracts";

/** How long the line tells of a finished Update: one day, then Settings' Updates section keeps it. */
export const UPDATED_LINE_MS = 24 * 60 * 60_000;

/** What the line's one action does; `label` is its words on screen. */
export type UpdateLineAction =
  /** Opens the release notes from the signed manifest in a dialog, so the Dashboard loads nothing from the internet. */
  | { kind: "what_changed"; label: "What changed"; version: string; notes: string }
  /** Install now and Restart now: both ask the service to install the verified Update at once. */
  | { kind: "install"; label: "Install" }
  | { kind: "restart"; label: "Restart now" }
  /** Goes to Settings' Updates section, which says why and what became of the database. */
  | { kind: "details"; label: "Details" };

export interface UpdateLine {
  /** Changes only when what the line says changes, so the announcement is read out once per line. */
  key: string;
  state: "updated" | "ready" | "waiting_for_jobs" | "installing" | "rolled_back" | "paused";
  /** `danger` for a failure, `warn` for Replication held back until the owner updates; everything else is plain news. */
  tone: "plain" | "warn" | "danger";
  text: string;
  action: UpdateLineAction | null;
}

export interface UpdateLineInput {
  /** Updates on this Machine (`GET /updates`); null until the service answered. */
  updates: UpdatesView | null;
  /** This Machine's Replication (`GET /replication`); null until the service answered. */
  replication?: ReplicationView | null;
  /** The time now, in ms since the epoch: the line of a finished Update goes after one day. */
  now: number;
  /**
   * The owner is in Settings' Updates section, which says everything about Updates and offers their actions itself:
   * only a paused Replication shows there, without an action.
   */
  inUpdatesSection?: boolean;
}

type Rule = (input: UpdateLineInput) => UpdateLine | null;

/** The last Update, while it is less than a day old. */
function recent(input: UpdateLineInput): LastUpdateView | null {
  const last = input.updates?.lastUpdate;
  if (!last) return null;
  const age = input.now - Date.parse(last.at);
  return age < UPDATED_LINE_MS ? last : null;
}

const pending: Rule = ({ updates: v }) => {
  const version = v?.update?.version;
  if (!v || !version) return null;
  switch (v.status) {
    case "installing":
      return { key: `installing:${version}`, state: "installing", tone: "plain", text: `Installing Attache ${version}`, action: null };
    case "waiting_for_jobs": {
      const jobs = v.jobs ?? 0;
      return { key: `waiting:${version}:${jobs}`, state: "waiting_for_jobs", tone: "plain", text: `Attache ${version} is waiting for ${plural(jobs, "Job")} to finish`, action: { kind: "restart", label: "Restart now" } };
    }
    case "ready":
      return { key: `ready:${version}`, state: "ready", tone: "plain", text: `Attache ${version} is ready`, action: { kind: "install", label: "Install" } };
    default:
      return null;
  }
};

const lastUpdate: Rule = (input) => {
  const last = recent(input);
  switch (last?.outcome) {
    case "updated":
      return { key: `updated:${last.to}:${last.at}`, state: "updated", tone: "plain", text: `Attache updated to ${last.to}`, action: { kind: "what_changed", label: "What changed", version: last.to, notes: last.notes } };
    case "rolled_back":
      return { key: `rolled_back:${last.to}:${last.at}`, state: "rolled_back", tone: "danger", text: `The Update to ${last.to} failed, so Attache went back to ${last.from}`, action: { kind: "details", label: "Details" } };
    default:
      // An Update that installed nothing left the Machine as it was: Settings tells it.
      return null;
  }
};

const PAUSED_TEXT = "Update this Machine to keep replicating";

/** The way to the Update a paused Machine needs: the one that waits for the owner, else where Updates are told. */
function pausedAction(v: UpdatesView | null): UpdateLineAction {
  if (v?.update && v.status === "ready") return { kind: "install", label: "Install" };
  if (v?.update && v.status === "waiting_for_jobs") return { kind: "restart", label: "Restart now" };
  return { kind: "details", label: "Details" };
}

/** Replication waits for this Machine to read the Brain's format: the line asks for the Update until it is installed. */
const paused: Rule = ({ replication, updates, inUpdatesSection }) => {
  const pause = replication?.status === "paused" ? replication.pause : null;
  if (!pause) return null;
  const action = inUpdatesSection ? null : pausedAction(updates);
  return { key: `paused:${pause.brainFormat}:${action?.kind ?? "none"}`, state: "paused", tone: "warn", text: PAUSED_TEXT, action };
};

/** Installing Attache: what happens now, also when it is the Update a paused Replication waits for. */
const installing: Rule = (input) => (input.updates?.status === "installing" ? pending(input) : null);

/** The rules, first match wins. */
const LINES: readonly Rule[] = [installing, paused, pending, lastUpdate];
/** Settings' Updates section tells every Update itself; only what holds Replication back shows above it. */
const IN_UPDATES_SECTION: readonly Rule[] = [paused];

export function updateLine(input: UpdateLineInput): UpdateLine | null {
  for (const rule of input.inUpdatesSection ? IN_UPDATES_SECTION : LINES) {
    const line = rule(input);
    if (line) return line;
  }
  return null;
}
