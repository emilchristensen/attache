import { homedir, platform } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * Service-owned locations. User knowledge lives in the chosen data folder;
 * everything here is service state (database, logs, runtime metadata) and is
 * never inside the vault.
 */
export interface ServicePaths {
  /** Root of service state, e.g. ~/Library/Application Support/Jarvis */
  stateDir: string;
  dbFile: string;
  logDir: string;
  runtimeFile: string;
  backupsDir: string;
  secretsFile: string;
  modelsDir: string;
}

export function defaultStateDir(): string {
  if (process.env.JARVIS_STATE_DIR) return process.env.JARVIS_STATE_DIR;
  const home = process.env.HOME || homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "Jarvis", "state");
  const xdg = process.env.XDG_STATE_HOME || join(home, ".local", "state");
  return join(xdg, "jarvis");
}

/**
 * Where writer locks live: one folder per user, shared by every Jarvis service
 * of that user whatever its state folder, so two services cannot both open one
 * data folder. It ignores TMPDIR and XDG variables on purpose, because a login
 * service and a terminal see different values for them.
 */
export function defaultLocksDir(): string {
  if (process.env.JARVIS_LOCK_DIR) return process.env.JARVIS_LOCK_DIR;
  const home = process.env.HOME || homedir();
  if (platform() === "darwin") return join(home, "Library", "Application Support", "Jarvis", "locks");
  if (platform() === "win32") return join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Jarvis", "locks");
  return join(home, ".local", "state", "jarvis", "locks");
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
