import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import type { Db } from "../core/db.ts";
import type { Logger } from "../core/log.ts";
import type { Clock } from "../replication/clock.ts";
import { CAPTURES_DIR, inCapturesArea, isMeeting } from "./capture-text.ts";

/**
 * How this Machine came to see a capture: it was in the folder when this
 * Machine started watching it, another Machine's change brought it, or it
 * arrived here. Only a capture that arrived here is consolidated here.
 */
type Arrival = "present" | "pulled" | "arrived";

export interface CaptureArrivalsDeps {
  db: Db;
  log: Logger;
  clock: Clock;
  /** The data folder in use, or null when none is open. */
  dataRoot: () => string | null;
  /** Called once for each meeting capture that arrived on this Machine. */
  arrived: (relPath: string) => void;
}

/**
 * Notices meeting captures that arrive in the Brain on this Machine, so each
 * is consolidated once, where it arrived. A capture arrives when it appears
 * in `evidence/captures/` by any route but Replication: an export routine or
 * an editor writing the file, or Jarvis itself. What is there when a folder is
 * first used, and what another Machine's change brings, is only recorded.
 * The record is this Machine's own state and never enters the Brain.
 */
export class CaptureArrivals {
  private readonly deps: CaptureArrivalsDeps;

  constructor(deps: CaptureArrivalsDeps) {
    this.deps = deps;
  }

  /**
   * The data folder was opened. A folder being adopted (set up, changed or
   * joined), or one never watched before, has its captures recorded as
   * present; a folder watched before is checked for captures that arrived
   * while Jarvis was not running.
   */
  opened(opts: { adopt: boolean }): void {
    const folder = this.deps.dataRoot();
    if (!folder) return;
    const watched = this.deps.db.prepare("select 1 from capture_watch where data_folder = ?").get(folder);
    if (watched && !opts.adopt) {
      this.check();
      return;
    }
    const now = this.now();
    for (const rel of listCaptures(folder)) this.record(folder, rel, "present", now);
    this.deps.db.prepare("insert into capture_watch (data_folder, since) values (?, ?) on conflict(data_folder) do update set since = excluded.since").run(folder, now);
  }

  /** Files another Machine changed reached this one: its captures were consolidated where they arrived. */
  pulled(paths: readonly string[]): void {
    const folder = this.deps.dataRoot();
    if (!folder) return;
    const now = this.now();
    for (const rel of paths) if (inCapturesArea(rel)) this.record(folder, toPosix(rel), "pulled", now);
  }

  /** Jarvis wrote a file in the data folder. */
  written(relPath: string): void {
    if (inCapturesArea(relPath)) this.check();
  }

  /** Find meeting captures this Machine has not seen yet, and hand each one on once. */
  check(): void {
    const folder = this.deps.dataRoot();
    if (!folder || !this.deps.db.prepare("select 1 from capture_watch where data_folder = ?").get(folder)) return;
    const seen = new Set((this.deps.db.prepare("select rel_path from capture_arrivals where data_folder = ?").all(folder) as Array<{ rel_path: string }>).map((r) => r.rel_path));
    for (const rel of listCaptures(folder)) {
      if (seen.has(rel) || !this.isMeetingFile(folder, rel)) continue;
      // Handed on before it is recorded: after a crash in between, the job's own key keeps it from running twice.
      this.deps.arrived(rel);
      this.record(folder, rel, "arrived", this.now());
    }
  }

  private isMeetingFile(folder: string, rel: string): boolean {
    try {
      return isMeeting(readFileSync(join(folder, rel), "utf8"));
    } catch (e) {
      // Removed or still being written: the next check reads it again.
      this.deps.log.warn("could not read a capture", { path: rel, error: (e as Error).message });
      return false;
    }
  }

  private record(folder: string, rel: string, arrival: Arrival, at: string): void {
    this.deps.db.prepare("insert into capture_arrivals (data_folder, rel_path, arrival, seen_at) values (?, ?, ?, ?) on conflict do nothing").run(folder, rel, arrival, at);
  }

  private now(): string {
    return this.deps.clock.now().toISOString();
  }
}

const toPosix = (rel: string) => rel.split(sep).join("/");

/** Every Markdown file in the captures area, as paths in the data folder. */
function listCaptures(folder: string): string[] {
  const dir = join(folder, CAPTURES_DIR);
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true, encoding: "utf8" }) as string[]).map((name) => `${CAPTURES_DIR}/${toPosix(name)}`).filter((rel) => inCapturesArea(rel) && !rel.split("/").some((part) => part.startsWith(".")));
}
