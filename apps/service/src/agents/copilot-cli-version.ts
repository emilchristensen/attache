import { existsSync } from "node:fs";
import { firstVersion, versionAnswer } from "./executable-version.ts";
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

/**
 * The installed Copilot CLI's version, or null when none was found, its
 * version could not be read, or, without `wait`, while its answer is not
 * known yet. Throws, saying what to do, for one too old for Attache's memory hook.
 */
export function checkCopilotCliVersion(home: string, opts: { wait: boolean } = { wait: true }): string | null {
  const path = copilotCliExecutables(home).find((p) => existsSync(p));
  if (!path) return null;
  const v = firstVersion(versionAnswer(path, { ...process.env, COPILOT_AUTO_UPDATE: "false" }, opts)?.output ?? "");
  if (!v) return null;
  const version = v.join(".");
  const older = v[0] - OLDEST_COPILOT_CLI[0] || v[1] - OLDEST_COPILOT_CLI[1] || v[2] - OLDEST_COPILOT_CLI[2];
  if (older < 0) throw new HooksFileError(`Copilot CLI ${version} (${path}) is too old for Attache's memory hook: run copilot update to get ${OLDEST_COPILOT_CLI.join(".")} or later, then connect again. Attache changed nothing.`);
  return version;
}
