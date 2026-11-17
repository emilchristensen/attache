import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { json, nowIso } from "../core/db.ts";
import { PolicyError } from "./policy.ts";

interface LockOwner {
  pid: number;
  instance: string;
}

/** Where versions before Machine identity kept the lock: inside the data folder, which Replication shares. */
const LEGACY_LOCK = join(".attache", "writer.lock");
const TAKE_ATTEMPTS = 3;
/** A lock file's name: a hash of the data folder's real path. */
const LOCK_FILE = /^[0-9a-f]{32}\.lock$/;

/**
 * The single-writer lock on one data folder. It lives outside the folder, in a
 * per-user locks folder, keyed by the folder's real path, so it never
 * replicates and every service of the user sees it.
 */
export class WriterLock {
  readonly folder: string;
  private readonly file: string;

  private constructor(folder: string, file: string) {
    this.folder = folder;
    this.file = file;
  }

  /**
   * Take the lock on `folder` for this process. Refused while another live
   * service of a different instance holds it; a lock left by a process that is
   * gone, or by an earlier run of the same instance, is taken over.
   */
  static acquire(folder: string, opts: { instance: string; locksDir: string }): WriterLock {
    const real = realpathSync(folder);
    clearLegacyLock(real, opts.instance);
    mkdirSync(opts.locksDir, { recursive: true, mode: 0o700 });
    const file = join(opts.locksDir, `${createHash("sha256").update(real).digest("hex").slice(0, 32)}.lock`);
    const record = JSON.stringify({ pid: process.pid, instance: opts.instance, dataFolder: real, at: nowIso() });
    for (let attempt = 0; attempt < TAKE_ATTEMPTS; attempt++) {
      try {
        writeFileSync(file, record, { flag: "wx", mode: 0o600 });
        return new WriterLock(real, file);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      refuseIfHeld(readOwner(file), opts.instance);
      rmSync(file, { force: true });
    }
    throw new PolicyError(`Could not take the writer lock for ${real}; another Attache service is starting on it`, "actor_denied");
  }

  /** Whether this lock covers `folder`. */
  covers(folder: string): boolean {
    try {
      return realpathSync(folder) === this.folder;
    } catch {
      return false;
    }
  }

  /** Remove the lock file, unless another process has taken it over since. */
  release(): void {
    if (readOwner(this.file)?.pid === process.pid) rmSync(this.file, { force: true });
  }
}

/**
 * Remove the locks in `locksDir` whose holder is gone, as a service killed
 * outright (a crash, or any hard stop on Windows) leaves them. A lock a live
 * process holds stays, and so does one that cannot be read, which may be a
 * service writing it this moment. Returns how many were removed and kept.
 */
export function clearStaleLocks(locksDir: string): { removed: number; kept: number } {
  if (!existsSync(locksDir)) return { removed: 0, kept: 0 };
  const locks = readdirSync(locksDir).filter((name) => LOCK_FILE.test(name)).map((name) => join(locksDir, name));
  const stale = locks.filter((file) => {
    const owner = readOwner(file);
    return owner !== null && owner.pid > 0 && !isAlive(owner.pid);
  });
  for (const file of stale) rmSync(file, { force: true });
  return { removed: stale.length, kept: locks.length - stale.length };
}

function readOwner(file: string): LockOwner | null {
  try {
    const owner = json<Partial<LockOwner>>(readFileSync(file, "utf8"), {});
    return { pid: Number(owner.pid) || 0, instance: String(owner.instance ?? "") };
  } catch {
    return null;
  }
}

function refuseIfHeld(owner: LockOwner | null, instance: string): void {
  if (!owner) return;
  const alive = owner.pid > 0 && owner.pid !== process.pid && isAlive(owner.pid);
  if (alive && owner.instance !== instance) throw new PolicyError(`Another Attache service (pid ${owner.pid}) owns this data folder`, "actor_denied");
}

/** Honour a lock an earlier version holds on the folder; remove it once nobody does. */
function clearLegacyLock(folder: string, instance: string): void {
  const legacy = join(folder, LEGACY_LOCK);
  if (!existsSync(legacy)) return;
  refuseIfHeld(readOwner(legacy), instance);
  rmSync(legacy, { force: true });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
