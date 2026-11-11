import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { platformLocations } from "../platform/locations.ts";

/**
 * Service-owned locations. User knowledge lives in the chosen data folder;
 * everything here is service state (database, logs, runtime metadata) and is
 * never inside the vault.
 */
export interface ServicePaths {
  /** Root of service state, e.g. ~/Library/Application Support/Jarvis/state on macOS. */
  stateDir: string;
  dbFile: string;
  logDir: string;
  runtimeFile: string;
  backupsDir: string;
  secretsFile: string;
  modelsDir: string;
}

/** `JARVIS_STATE_DIR` when set, otherwise this operating system's default (`platform/locations.ts`). */
export function defaultStateDir(): string {
  return process.env.JARVIS_STATE_DIR || platformLocations().stateDir;
}

/** `JARVIS_LOCK_DIR` when set, otherwise this operating system's writer-lock folder (`platform/locations.ts`). */
export function defaultLocksDir(): string {
  return process.env.JARVIS_LOCK_DIR || platformLocations().locksDir;
}

export function resolvePaths(stateDir = defaultStateDir()): ServicePaths {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const paths: ServicePaths = {
    stateDir,
    dbFile: join(stateDir, "jarvis.sqlite"),
    logDir: join(stateDir, "logs"),
    runtimeFile: join(stateDir, "runtime.json"),
    backupsDir: join(stateDir, "backups"),
    secretsFile: join(stateDir, "secrets.json"),
    modelsDir: join(stateDir, "models"),
  };
  for (const dir of [paths.logDir, paths.backupsDir, paths.modelsDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return paths;
}
