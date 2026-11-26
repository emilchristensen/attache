import { z } from "zod";
import { MachineView } from "./config.ts";

/** API contract: Replication. */

/**
 * off: not set up. offline: the remote cannot be reached; saves carry on and catch up later.
 * paused: the Brain is in a format newer than this Machine can read (`ReplicationView.pause` says which);
 * it merges, commits and pushes nothing until it is updated, and saves carry on here.
 */
export const ReplicationStatus = z.enum(["off", "up_to_date", "offline", "unauthorized", "blocked", "paused"]);
export type ReplicationStatus = z.infer<typeof ReplicationStatus>;

/**
 * Why Replication is paused, for the Dashboard line, the system notification and
 * the Update check that ask the owner to update this Machine (ADR 0008).
 */
export interface ReplicationPause {
  reason: "newer_brain_format";
  /** The Brain format the Brain is in. */
  brainFormat: number;
  /** The newest Brain format this Machine's Attache can read. */
  readsBrainFormat: number;
}

export interface ReplicationView {
  status: ReplicationStatus;
  /** The repository's address; never holds a token. */
  remote: string | null;
  /** What to fix, when the status is not up to date. */
  cause: string | null;
  lastCheckedAt: string | null;
  lastPushedAt: string | null;
  /** The last time this Machine had the other Machines' changes and had sent its own; setup and join count. */
  upToDateAt: string | null;
  /** Set exactly while the status is paused. */
  pause: ReplicationPause | null;
}

const RepositoryName = z.string().trim().min(1, "Name the repository").max(500);
export const ReplicationSetupInput = z.object({ remote: RepositoryName });
export type ReplicationSetupInput = z.infer<typeof ReplicationSetupInput>;
/**
 * A Machine as every Machine sees it: its record in the Brain. Standby and the
 * Preferred Reader live in the Brain, so they read the same everywhere.
 */
export interface ReplicatedMachineView {
  id: string;
  name: string;
  /** May take over as Reader when the Reader goes silent. */
  standby: boolean;
  /** The Machine whose Dashboard is asking. */
  thisMachine: boolean;
  /** The Attache version the Machine runs; null when its record comes from a version that did not record it. */
  version: string | null;
  /** When this Machine's last change reached the Brain's history here; null when none has yet. */
  lastChangeAt: string | null;
}

export interface ReplicationMachinesView {
  /** This Machine first. With Replication off, only this Machine. */
  machines: ReplicatedMachineView[];
  /** The id of the Machine that should be the Reader whenever it is online; null when none is chosen. */
  preferredReader: string | null;
}

/** A Reader lease not renewed for this long has lapsed: the Reader is silent. The Dashboard asks again at that moment. */
export const READER_SILENT_AFTER_MS = 30 * 60_000;

/**
 * The Reader: the one Machine that runs scheduled Source refresh, briefings
 * and Review-date inbox items. With Replication off, this Machine is its own Reader.
 */
export interface ReaderView {
  /** The Reader as this Machine last heard; null while no Machine has taken the role yet. */
  machine: MachineView | null;
  /** The Reader is the Machine whose Dashboard is asking. */
  thisMachine: boolean;
  /** False with Replication off. */
  replicated: boolean;
  /** When the Reader last renewed its lease; null with Replication off. */
  heartbeatAt: string | null;
  /** The Reader has not renewed its lease for 30 minutes, so it no longer counts as the Reader. */
  silent: boolean;
  /** When the Reader's last Source refresh of every source finished; null when none has. */
  lastRefreshAt: string | null;
}

export const ReplicationStandbyInput = z.object({ standby: z.boolean() });
export type ReplicationStandbyInput = z.infer<typeof ReplicationStandbyInput>;
/** `machine`: a listed Machine's id, or null for no Preferred Reader. */
export const PreferredReaderInput = z.object({ machine: z.uuid("Choose one of the listed Machines").nullable() });
export type PreferredReaderInput = z.infer<typeof PreferredReaderInput>;

/** `path`: the empty folder to clone into; the configured data folder when left out. */
export const ReplicationJoinInput = z.object({ remote: RepositoryName, path: z.string().trim().min(1).max(1000).optional() });
export type ReplicationJoinInput = z.infer<typeof ReplicationJoinInput>;
