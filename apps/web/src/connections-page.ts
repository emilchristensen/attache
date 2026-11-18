import type { ConnectionDefinition, ConnectionKind, ConnectionStatus } from "@attache/contracts";
import { CONNECTION_LOOK, connectionState, nameList, type ConnectionState, type StatusRow } from "./connection-status.ts";

/**
 * The Connections page (#31 of spec #14), from the Connections the service lists: rows in four groups for what is set
 * up, small tiles under each group for what is not, and a "Needs you" group first while a Connection needs sign-in.
 */

export type GroupId = "needs_you" | "notes" | "work" | "harnesses" | "model";

/** A set-up Connection's problem, in the words, colour and glyph Home's Connections area uses for it. */
export type RowProblem = { state: ConnectionState } & Pick<StatusRow, "word" | "hue" | "icon">;

export interface PageRow {
  connection: ConnectionStatus;
  /** Null when it works: a healthy Connection carries no state word. */
  problem: RowProblem | null;
}

export interface PageGroup {
  id: GroupId;
  title: string;
  rows: PageRow[];
  /** Connections not set up (or disconnected), shown as small tiles under the group's rows. */
  tiles: ConnectionStatus[];
}

const GROUPS: ReadonlyArray<{ id: Exclude<GroupId, "needs_you">; title: string; kinds: readonly ConnectionKind[] }> = [
  { id: "notes", title: "Notes", kinds: ["vault"] },
  { id: "work", title: "Work sources", kinds: ["github", "jira", "confluence", "slack", "gmail", "gcal"] },
  { id: "harnesses", title: "Harnesses", kinds: ["claude-code", "codex", "antigravity", "claude-desktop"] },
  { id: "model", title: "Model", kinds: ["model"] },
];

/** Set up and meant to work: neither waiting to be set up nor disconnected by the owner. */
function setUp(c: ConnectionStatus): boolean {
  return c.status !== "not_configured" && c.status !== "disconnected";
}

function rowOf(c: ConnectionStatus, attentionOn: boolean): PageRow {
  const state = connectionState(c, attentionOn);
  return { connection: c, problem: state && { state, ...CONNECTION_LOOK[state] } };
}

/**
 * The groups in page order. "Needs you" comes first while a Connection needs sign-in and holds it instead of its own
 * group, so each Connection is one row. A group with nothing in it is left out, except Notes, where a folder is imported.
 */
export function connectionsPage(connections: ConnectionStatus[], attentionOn: boolean): PageGroup[] {
  // In page order, so "Needs you" lists them in the order their own groups would.
  const rows = GROUPS.flatMap((g) => connections.filter((c) => g.kinds.includes(c.kind) && setUp(c)).map((c) => rowOf(c, attentionOn)));
  const needsYou = rows.filter((r) => r.problem?.state === "sign_in");
  const groups = GROUPS.map((g) => ({
    id: g.id,
    title: g.title,
    rows: rows.filter((r) => g.kinds.includes(r.connection.kind) && !needsYou.includes(r)),
    tiles: connections.filter((c) => g.kinds.includes(c.kind) && !setUp(c)),
  })).filter((g) => g.id === "notes" || g.rows.length > 0 || g.tiles.length > 0);
  return needsYou.length ? [{ id: "needs_you", title: "Needs you", rows: needsYou, tiles: [] }, ...groups] : groups;
}

const HARNESSES: readonly ConnectionKind[] = ["claude-code", "codex", "antigravity", "claude-desktop"];

/** The columns of one row: who it is signed in as, what Attache may read and write there, and when it last read or answered. */
export interface RowCells {
  /** The account, folder or settings file; null when the service names none. */
  account: string | null;
  /** What follows "Reads": "pull requests requesting my review", "nothing". */
  reads: string;
  /** What follows "Writes": "nothing", "the Brain". */
  writes: string;
  /** Sources show their last finished Source refresh; the model and Harnesses when they last answered. */
  last: { label: "Last read" | "Last answered"; at: string | null };
}

/** "GitHub ...", "PR ...": a first word with a capital after its first letter is a name and keeps its case. */
function startsWithName(label: string): boolean {
  return /[A-Z]/.test((label.split(/\s/)[0] ?? "").slice(1));
}

/** Labels joined as a phrase that follows "Reads" or "Writes", lower case unless a label starts with a name: "pull requests requesting my review and issues assigned to me". */
function phrase(labels: string[]): string {
  return nameList(labels.map((l) => (startsWithName(l) ? l : l.charAt(0).toLowerCase() + l.slice(1))));
}

function labelled(ids: string[], known: Array<{ id: string; label: string }>): string[] {
  return ids.map((id) => known.find((k) => k.id === id)?.label ?? id);
}

export function rowCells(c: ConnectionStatus, def: ConnectionDefinition): RowCells {
  const at = (label: RowCells["last"]["label"], when: string | null) => ({ label, at: when });
  if (c.kind === "model") return { account: c.account, reads: "only what Attache sends it", writes: "nothing", last: at("Last answered", c.lastSuccessAt) };
  if (HARNESSES.includes(c.kind)) return { account: c.account, reads: "the Brain", writes: "to the Brain", last: at("Last answered", c.lastSuccessAt) };
  const reads = c.readScopes.length ? phrase(labelled(c.readScopes, def.scopes)) : "nothing";
  const writes = c.settings.builtin === true ? "the Brain" : c.writeActions.length ? phrase(labelled(c.writeActions, def.writeActions)) : "nothing";
  return { account: c.account, reads, writes, last: at("Last read", c.lastReadAt) };
}

/** The rows open when the page opens: every row in "Needs you", and the row or tile a link names with `?open=<id>`. */
export function openAtStart(groups: PageGroup[], openId: string | null): Set<string> {
  const needsYou = groups.find((g) => g.id === "needs_you")?.rows.map((r) => r.connection.id) ?? [];
  const shown = groups.some((g) => g.rows.some((r) => r.connection.id === openId) || g.tiles.some((t) => t.id === openId));
  return new Set(openId && shown ? [...needsYou, openId] : needsYou);
}
