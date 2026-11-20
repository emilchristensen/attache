import { existsSync, statSync } from "node:fs";
import { runSync } from "../platform/run.ts";
import { locationsForHome } from "../platform/locations.ts";
import { copilotCliInstall } from "../platform/harness-locations.ts";
import { HooksFileError } from "./hooks-config.ts";

/**
 * Which Copilot CLI is installed. Before 1.0.11 Copilot CLI ignored a
 * session-start hook's `additionalContext`, and before 1.0.22 it ran
 * session-start hooks before every prompt, so Attache refuses an older one
 * it can see. Copilot CLI updates itself by default, so a version Attache
 * cannot read (or an executable it cannot run, such as the npm loader with
 * no Node on the service's PATH) does not stop a connection.
 */

/** The oldest Copilot CLI that injects a session-start hook's `additionalContext` once per session. */
export const OLDEST_COPILOT_CLI = [1, 0, 22] as const;

/** The places Copilot CLI may be installed; `ATTACHE_COPILOT_BIN` replaces them all, so tests never run the Machine's own. */
export function copilotCliExecutables(home: string): string[] {
  const only = process.env.ATTACHE_COPILOT_BIN;
  return only ? [only] : copilotCliInstall(locationsForHome(home)).executables;
}

const versions = new Map<string, { stamp: string; output: string | null }>();

/** What `copilot --version` prints, null when it could not run; remembered until the executable changes. */
function versionOutput(path: string): string | null {
  const { mtimeMs, size } = statSync(path);
  const stamp = `${mtimeMs}:${size}`;
  const known = versions.get(path);
  if (known?.stamp === stamp) return known.output;
  const r = runSync(path, ["--version"], { timeoutMs: 15_000, env: { ...process.env, COPILOT_AUTO_UPDATE: "false" } });
  const output = r.code === 0 ? r.stdout.trim() : null;
  versions.set(path, { stamp, output });
  return output;
}

/**
 * The installed Copilot CLI's version, or null when none was found or its
 * version could not be read. Throws, saying what to do, for one too old for
 * Attache's memory hook.
 */
export function checkCopilotCliVersion(home: string): string | null {
  const path = copilotCliExecutables(home).find((p) => existsSync(p));
  if (!path) return null;
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput(path) ?? "");
  if (!m) return null;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  const version = v.join(".");
  const older = v[0]! - OLDEST_COPILOT_CLI[0] || v[1]! - OLDEST_COPILOT_CLI[1] || v[2]! - OLDEST_COPILOT_CLI[2];
  if (older < 0) throw new HooksFileError(`Copilot CLI ${version} (${path}) is too old for Attache's memory hook: run copilot update to get ${OLDEST_COPILOT_CLI.join(".")} or later, then connect again. Attache changed nothing.`);
  return version;
}
