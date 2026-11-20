import { existsSync, statSync } from "node:fs";
import { runSync } from "../platform/run.ts";
import { locationsForHome } from "../platform/locations.ts";
import { openCodeInstall } from "../platform/harness-locations.ts";
import { HooksFileError } from "./hooks-config.ts";

/**
 * Which OpenCode is installed. OpenCode 1 (`opencode-ai`) and OpenCode 2
 * (`@opencode/cli`) both install an `opencode` command with incompatible
 * plugin APIs, so Attache asks the executable before it writes a plugin.
 */

/** The oldest OpenCode 1 whose loader accepts a default-exported plugin object that also carries OpenCode 2's entry point. */
const OLDEST_V1 = [1, 18, 29] as const;

/**
 * The places OpenCode may be installed, in the order Attache prefers them.
 * `ATTACHE_OPENCODE_BIN` replaces them all, so tests never run whatever
 * OpenCode the Machine has.
 */
export function openCodeExecutables(home: string): string[] {
  const only = process.env.ATTACHE_OPENCODE_BIN;
  return only ? [only] : openCodeInstall(locationsForHome(home)).executables;
}

/** Whether OpenCode looks installed: its installer's folder or one of its executables exists. */
export function openCodeFound(home: string): boolean {
  const install = openCodeInstall(locationsForHome(home));
  return [...install.presence.filter((p) => !install.executables.includes(p)), ...openCodeExecutables(home)].some((p) => existsSync(p));
}

const versions = new Map<string, { stamp: string; version: string }>();

/** What `opencode --version` prints, remembered until the executable changes. */
function versionOutput(path: string): string {
  const { mtimeMs, size } = statSync(path);
  const stamp = `${mtimeMs}:${size}`;
  const known = versions.get(path);
  if (known?.stamp === stamp) return known.version;
  const r = runSync(path, ["--version"], { timeoutMs: 15_000, env: { ...process.env, OPENCODE_DISABLE_AUTOUPDATE: "1" } });
  if (r.code !== 0) throw new HooksFileError(`Attache could not run ${path} --version (${r.stderr.trim() || `exit ${r.code}`}), so it could not tell which OpenCode is installed. Attache changed nothing.`);
  const version = r.stdout.trim();
  versions.set(path, { stamp, version });
  return version;
}

/**
 * The installed OpenCode's version, or null when none was found. Throws,
 * saying what to do, for a version Attache's plugin does not work with.
 */
export function checkOpenCodeVersion(home: string): string | null {
  const path = openCodeExecutables(home).find((p) => existsSync(p));
  if (!path) return null;
  const output = versionOutput(path);
  const m = /^(?:opencode\s+)?v?(\d+)\.(\d+)\.(\d+)\S*$/i.exec(output);
  if (!m) throw new HooksFileError(`Attache could not tell which OpenCode ${path} is (it printed "${output.slice(0, 80)}"). Attache changed nothing.`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const version = `${major}.${minor}.${patch}`;
  if (major === 1) {
    const older = minor < OLDEST_V1[1] || (minor === OLDEST_V1[1] && patch < OLDEST_V1[2]);
    if (older) throw new HooksFileError(`OpenCode ${version} is too old for Attache's plugin: update to OpenCode ${OLDEST_V1.join(".")} or later, or OpenCode 2, then connect again. Attache changed nothing.`);
    return version;
  }
  if (major === 2) return version;
  throw new HooksFileError(`OpenCode ${version} is a version Attache does not support yet; Attache's plugin is written for OpenCode 1 (${OLDEST_V1.join(".")} or later) and OpenCode 2. Attache changed nothing.`);
}
