import { z } from "zod";
import { MACHINE_NAME_MAX } from "@jarvis/contracts";

/**
 * The Reader lease: which Machine runs scheduled Source refresh, briefings and
 * Review-date inbox items. One record, shared through the Brain's repository
 * but outside its history (see `replication/lease-ref.ts`). The holder renews
 * it on a heartbeat; a lease not renewed for `LEASE_TTL_MS` has lapsed, and
 * its holder stops acting as the Reader until it renews.
 */

/** The holder renews the lease at least this often while it can reach the repository. */
export const HEARTBEAT_EVERY_MS = 10 * 60_000;
/** A lease not renewed for this long has lapsed: its holder is silent. */
export const LEASE_TTL_MS = 30 * 60_000;

export const LeaseRecord = z.object({
  version: z.literal(1),
  /** The Machine id of the Reader. */
  holder: z.uuid(),
  /** Its name when it last renewed. */
  name: z.string().min(1).max(MACHINE_NAME_MAX),
  /** When the holder took the lease. */
  since: z.iso.datetime(),
  /** The heartbeat: when the holder last renewed. */
  renewedAt: z.iso.datetime(),
  /** When the last Source refresh of every source finished, on this Reader or the one before it. */
  lastRefreshAt: z.iso.datetime().nullable(),
});
export type LeaseRecord = z.infer<typeof LeaseRecord>;

export interface LeaseMachine {
  id: string;
  name: string;
}

export interface LeaseContext {
  me: LeaseMachine;
  /** The Preferred Reader recorded in the Brain; null when none is chosen. */
  preferredReader: string | null;
  /**
   * Whether this Machine may take the place of a silent Reader: it is marked
   * standby in the Brain and has a source of its own connected to read.
   */
  standIn: boolean;
  /** Whether this Machine set up Replication of the Brain (it made the first commit). */
  founder: boolean;
  now: Date;
  /** This Machine's own last Source refresh of every source. */
  lastRefreshAt: string | null;
}

/** The later of two ISO times; null only when both are. */
export const later = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b);

/** A lease not renewed for `LEASE_TTL_MS`: its holder is silent and no longer counts as the Reader. */
export function hasLapsed(lease: LeaseRecord, now: Date): boolean {
  return now.getTime() - Date.parse(lease.renewedAt) >= LEASE_TTL_MS;
}

/**
 * What this Machine writes to the lease now, or null to leave it as it is.
 * The holder renews on its heartbeat, and at once when its name or last
 * Source refresh changed. The Preferred Reader takes the lease whenever it does
 * not hold it, so it takes the role back when it returns. A standby Machine
 * with its sources connected takes a lease that lapsed (the Reader has been
 * silent for `LEASE_TTL_MS`) or that nobody holds yet. A lease nobody holds is
 * also taken by the Machine that set up Replication, unless the owner chose
 * another Preferred Reader, so a Brain always gets a Reader. A lease another
 * Machine holds is otherwise left alone.
 */
export function leaseToWrite(current: LeaseRecord | null, ctx: LeaseContext): LeaseRecord | null {
  const now = ctx.now.toISOString();
  if (current?.holder === ctx.me.id) {
    const lastRefreshAt = later(current.lastRefreshAt, ctx.lastRefreshAt);
    const due = ctx.now.getTime() - Date.parse(current.renewedAt) >= HEARTBEAT_EVERY_MS;
    if (!due && current.name === ctx.me.name && current.lastRefreshAt === lastRefreshAt) return null;
    return { ...current, name: ctx.me.name, since: hasLapsed(current, ctx.now) ? now : current.since, renewedAt: now, lastRefreshAt };
  }
  const unheld = current === null;
  const claim =
    ctx.preferredReader === ctx.me.id ||
    (ctx.standIn && (unheld || hasLapsed(current, ctx.now))) ||
    (unheld && ctx.founder && ctx.preferredReader === null);
  if (!claim) return null;
  return { version: 1, holder: ctx.me.id, name: ctx.me.name, since: now, renewedAt: now, lastRefreshAt: later(current?.lastRefreshAt ?? null, ctx.lastRefreshAt) };
}
