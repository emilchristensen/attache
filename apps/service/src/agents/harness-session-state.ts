import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { HarnessApplyResult, HarnessUninstallResult } from "@attache/contracts";
import type { HarnessAdapter } from "./harness-adapters.ts";
import { replaceFile } from "./hooks-config.ts";
import { agentsDir, contextFile } from "./spool.ts";
import type { Turn } from "./transcripts.ts";

type SessionHarness = "pi" | "opencode" | "copilot-cli";

export function hasHarnessSessionState(kind: string): kind is SessionHarness {
  return kind === "pi" || kind === "opencode" || kind === "copilot-cli";
}

const marker = (stateDir: string, kind: SessionHarness) => join(agentsDir(stateDir), "connected", kind);
type HarnessLocation = { root: string; owner: string };
type CapturePause = { from: number; until: number | null };
type SessionState = { active: boolean; locations: HarnessLocation[]; pauses: CapturePause[] };

const validLocation = (location: HarnessLocation | null): boolean => !!location && typeof location.root === "string" && isAbsolute(location.root) && typeof location.owner === "string" && /^attache(?:-[0-9a-f]{8})?$/.test(location.owner);
const validPause = (pause: CapturePause | null): boolean => !!pause && Number.isFinite(pause.from) && (pause.until === null || (Number.isFinite(pause.until) && pause.until >= pause.from));

function readState(file: string): SessionState | null {
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as Partial<SessionState> | null;
    if (!state || typeof state.active !== "boolean" || !Array.isArray(state.locations) || !state.locations.every(validLocation)) return null;
    const pauses = state.pauses ?? [];
    if (!Array.isArray(pauses) || !pauses.every(validPause)) return null;
    return { active: state.active, locations: state.locations, pauses };
  } catch {
    // If the grant is absent or damaged, the hook has no permission to run.
    return null;
  }
}

/** Hooks run outside the service and can outlive their configuration files. */
export function harnessSessionActive(stateDir: string, kind: SessionHarness): boolean {
  return harnessSessionState(stateDir, kind)?.active === true && existsSync(contextFile(stateDir));
}

export function harnessSessionState(stateDir: string, kind: SessionHarness): SessionState | null {
  return readState(marker(stateDir, kind));
}

/** Snapshots already copied when the owner disconnects can still be drained. */
export function canIngestHarnessSnapshot(state: SessionState, at: string): boolean {
  if (!state.active && state.pauses.at(-1)?.until !== null) return false;
  const ms = Date.parse(at);
  return Number.isFinite(ms) && !state.pauses.some(({ from, until }) => ms > from && (until === null || ms < until));
}

const overlapsPause = (state: SessionState, started: number, ended: number) =>
  state.pauses.some(({ from, until }) => ended >= from && (until === null || started < until));

/** The Harness's title can describe earlier turns omitted from a partial snapshot. */
export function sessionMaySpanCapturePause(state: SessionState, createdAt: string | undefined, capturedAt: string): boolean {
  const created = createdAt ? Date.parse(createdAt) : NaN;
  return overlapsPause(state, Number.isFinite(created) ? created : -Infinity, Date.parse(capturedAt));
}

/** A resumed session may include turns the owner wrote while the Connection was off. */
export function turnsWhileConnected(turns: Turn[], state: SessionState): Turn[] {
  if (!state.pauses.length) return turns;
  let promptAllowed = true;
  return turns.filter((turn) => {
    const started = turn.at === null ? NaN : Date.parse(turn.at);
    const ended = turn.completedAt === undefined ? started : turn.completedAt === null ? NaN : Date.parse(turn.completedAt);
    const allowed = Number.isFinite(started) && Number.isFinite(ended) && !overlapsPause(state, started, ended);
    if (turn.role === "user") promptAllowed = allowed;
    return allowed && promptAllowed;
  });
}

export type RootedHarnessAdapter = Omit<HarnessAdapter, "uninstall"> & { uninstall(location: HarnessLocation): HarnessUninstallResult };

/** Record where the service installed the Harness, since the command-line uninstaller can see a different environment. */
export function withHarnessSessionState(kind: SessionHarness, adapter: RootedHarnessAdapter, stateDir: string, location: () => HarnessLocation): HarnessAdapter {
  const file = marker(stateDir, kind);
  const writeState = (state: SessionState) => replaceFile(file, JSON.stringify(state));
  const activate = (result: HarnessApplyResult) => {
    const state = readState(file);
    const here = location();
    const known = state?.locations ?? [];
    const locations = known.some((entry) => entry.root === here.root && entry.owner === here.owner) ? known : [...known, here];
    const pauses = state?.pauses ?? [];
    const last = pauses.at(-1);
    if (!state?.active || locations !== known) {
      const closed = last?.until === null ? [...pauses.slice(0, -1), { ...last, until: Math.max(Date.now(), last.from) }] : pauses;
      writeState({ active: true, locations, pauses: closed });
    }
    return result;
  };
  return {
    ...adapter,
    apply: () => activate(adapter.apply()),
    refresh: () => activate(adapter.refresh()),
    uninstall: () => {
      const state = readState(file);
      const locations = state?.locations ?? [location()];
      const removed: HarnessUninstallResult["removed"] = [];
      const failures: string[] = [];
      const paused = state?.active ? { ...state, active: false, pauses: [...state.pauses, { from: Date.now(), until: null }] } : state;
      try {
        if (paused && paused !== state) writeState(paused);
      } catch (e) {
        failures.push(`Could not stop the loaded Harness hooks at ${file}: ${(e as Error).message}`);
      }
      for (const here of locations) {
        const result = adapter.uninstall(here);
        removed.push(...result.removed);
        failures.push(...result.failures);
      }
      if (!failures.length && paused && locations.length) {
        try {
          writeState({ ...paused, locations: [] });
        } catch (e) {
          failures.push(`Could not update Attache's inactive Harness state at ${file}: ${(e as Error).message}`);
        }
      }
      return { removed, failures };
    },
  };
}
