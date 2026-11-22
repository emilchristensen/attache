import { existsSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { HarnessApplyResult, HarnessUninstallResult } from "@attache/contracts";
import type { HarnessAdapter } from "./harness-adapters.ts";
import { replaceFile } from "./hooks-config.ts";
import { agentsDir, contextFile } from "./spool.ts";

type SessionHarness = "pi" | "opencode" | "copilot-cli";

export function hasHarnessSessionState(kind: string): kind is SessionHarness {
  return kind === "pi" || kind === "opencode" || kind === "copilot-cli";
}

const marker = (stateDir: string, kind: SessionHarness) => join(agentsDir(stateDir), "connected", kind);
type HarnessLocation = { root: string; owner: string };
type SessionState = { active: boolean; locations: HarnessLocation[] };

const validLocation = (location: HarnessLocation | null): boolean => !!location && typeof location.root === "string" && isAbsolute(location.root) && typeof location.owner === "string" && /^attache(?:-[0-9a-f]{8})?$/.test(location.owner);

function readState(file: string): SessionState | null {
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as Partial<SessionState> | null;
    return state && typeof state.active === "boolean" && Array.isArray(state.locations) && state.locations.every(validLocation)
      ? { active: state.active, locations: state.locations }
      : null;
  } catch {
    // If the grant is absent or damaged, the hook has no permission to run.
    return null;
  }
}

/** Hooks run outside the service and can outlive their configuration files. */
export function harnessSessionActive(stateDir: string, kind: SessionHarness): boolean {
  return harnessSessionConnected(stateDir, kind) && existsSync(contextFile(stateDir));
}

/** A Configuration test can report an error while an installed hook is still running. */
export function harnessSessionConnected(stateDir: string, kind: SessionHarness): boolean {
  return readState(marker(stateDir, kind))?.active === true;
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
    if (!state?.active || locations !== known) writeState({ active: true, locations });
    return result;
  };
  return {
    ...adapter,
    apply: () => activate(adapter.apply()),
    refresh: () => activate(adapter.refresh()),
    uninstall: () => {
      const state = readState(file);
      const locations = state?.locations.length ? state.locations : [location()];
      const removed: HarnessUninstallResult["removed"] = [];
      const failures: string[] = [];
      try {
        if (state?.active) writeState({ ...state, active: false });
      } catch (e) {
        failures.push(`Could not stop the loaded Harness hooks at ${file}: ${(e as Error).message}`);
      }
      for (const here of locations) {
        const result = adapter.uninstall(here);
        removed.push(...result.removed);
        failures.push(...result.failures);
      }
      if (!failures.length) {
        try {
          rmSync(file, { force: true });
        } catch (e) {
          failures.push(`Could not remove Attache's inactive Harness state at ${file}: ${(e as Error).message}`);
        }
      }
      return { removed, failures };
    },
  };
}
