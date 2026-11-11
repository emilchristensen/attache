import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { currentOs, type Os } from "./os.ts";

/**
 * Every place on disk that differs between operating systems, resolved in
 * one place. Pure: the same operating system and environment always give the
 * same answer, and nothing is created on disk.
 */
export interface PlatformLocations {
  os: Os;
  home: string;
  /** Where a release installs: app versions, the `current` link and, on macOS and Windows, the service state. */
  installPrefix: string;
  /** Default service state folder, used when neither `JARVIS_STATE_DIR` nor `--state-dir` is given. */
  stateDir: string;
  /**
   * Writer locks: one folder per user, shared by every Jarvis service of that
   * user whatever its state folder, so two services cannot both open one data
   * folder. It ignores XDG variables on purpose, because a login service and a
   * terminal can see different values for them.
   */
  locksDir: string;
  /** Folder for the command-line entry points `jarvis` and `jarvis-uninstall`. */
  binDir: string;
  /** Folder of per-user service definitions (LaunchAgents, systemd user units); null where the service manager keeps none on disk. */
  serviceDefinitionDir: string | null;
  /** Archive tool for backup and restore. */
  tar: string;
  /** Organisation-managed Claude Code settings, which also apply to headless sessions. */
  claudeManagedSettings: string;
  /** Folders where command-line tools (Harness CLIs, gh) are commonly installed, in lookup order. */
  toolDirs: string[];
}

export type Env = Readonly<Record<string, string | undefined>>;

/** Path functions for an operating system, so Windows paths resolve correctly on any host. */
export const pathFor = (os: Os): typeof posix => (os === "windows" ? win32 : posix);

function homeFor(os: Os, env: Env): string {
  return (os === "windows" ? env.USERPROFILE : env.HOME) || homedir();
}

function macos(env: Env): PlatformLocations {
  const home = homeFor("macos", env);
  const { join } = posix;
  const installPrefix = join(home, "Library", "Application Support", "Jarvis");
  return {
    os: "macos",
    home,
    installPrefix,
    stateDir: join(installPrefix, "state"),
    locksDir: join(installPrefix, "locks"),
    binDir: join(home, ".local", "bin"),
    serviceDefinitionDir: join(home, "Library", "LaunchAgents"),
    tar: "/usr/bin/tar",
    claudeManagedSettings: "/Library/Application Support/ClaudeCode/managed-settings.json",
    toolDirs: [join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"],
  };
}

function linux(env: Env): PlatformLocations {
  const home = homeFor("linux", env);
  const { join } = posix;
  return {
    os: "linux",
    home,
    installPrefix: join(env.XDG_DATA_HOME || join(home, ".local", "share"), "jarvis"),
    stateDir: join(env.XDG_STATE_HOME || join(home, ".local", "state"), "jarvis"),
    locksDir: join(home, ".local", "state", "jarvis", "locks"),
    binDir: join(home, ".local", "bin"),
    serviceDefinitionDir: join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user"),
    tar: "tar",
    claudeManagedSettings: "/etc/claude-code/managed-settings.json",
    toolDirs: [join(home, ".local", "bin"), "/usr/local/bin", "/usr/bin"],
  };
}

function windows(env: Env): PlatformLocations {
  const home = homeFor("windows", env);
  const { join } = win32;
  const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local");
  const appData = env.APPDATA || join(home, "AppData", "Roaming");
  const installPrefix = join(localAppData, "Jarvis");
  return {
    os: "windows",
    home,
    installPrefix,
    stateDir: join(installPrefix, "state"),
    locksDir: join(installPrefix, "locks"),
    binDir: join(installPrefix, "bin"),
    // The per-user logon task lives in Task Scheduler, not in a file.
    serviceDefinitionDir: null,
    tar: join(env.SystemRoot || "C:\\Windows", "System32", "tar.exe"),
    claudeManagedSettings: join(env.ProgramFiles || "C:\\Program Files", "ClaudeCode", "managed-settings.json"),
    toolDirs: [join(home, ".local", "bin"), join(appData, "npm")],
  };
}

const BY_OS: Readonly<Record<Os, (env: Env) => PlatformLocations>> = { macos, linux, windows };

/** The locations for an operating system (this one by default). Throws `UnsupportedPlatformError` on any other. */
export function platformLocations(os: Os = currentOs(), env: Env = process.env): PlatformLocations {
  return BY_OS[os](env);
}

/** The locations as seen from another home folder, e.g. the one whose Harness settings Jarvis edits. */
export function locationsForHome(home: string, os: Os = currentOs(), env: Env = process.env): PlatformLocations {
  return platformLocations(os, { ...env, [os === "windows" ? "USERPROFILE" : "HOME"]: home });
}

/** File names a command-line tool goes by: Windows adds `.exe` for native binaries and `.cmd` for npm shims. */
export function executableNames(os: Os, name: string): string[] {
  return os === "windows" ? [`${name}.exe`, `${name}.cmd`] : [name];
}

/** Every place a command-line tool may be installed, in lookup order. */
export function toolCandidates(loc: PlatformLocations, name: string): string[] {
  const { join } = pathFor(loc.os);
  return loc.toolDirs.flatMap((dir) => executableNames(loc.os, name).map((file) => join(dir, file)));
}

/**
 * The name the service manager knows this install by: the LaunchAgent label,
 * the systemd user unit, or the logon task. Each instance gets its own, so
 * test installs never collide with the owner's.
 */
export function serviceName(os: Os, instance: string): string {
  const isDefault = instance === "default";
  if (os === "macos") return isDefault ? "dev.jarvis.service" : `dev.jarvis.${instance}`;
  if (os === "linux") return isDefault ? "jarvis.service" : `jarvis-${instance}.service`;
  return isDefault ? "Jarvis" : `Jarvis-${instance}`;
}

/** Expand a leading `~` to the home folder, as a shell would. */
export function expandHome(path: string, loc: PlatformLocations = platformLocations()): string {
  return path.replace(/^~(?=[/\\]|$)/, loc.home);
}
