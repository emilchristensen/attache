/**
 * Whether this copy of Attache is a release install, the only kind that
 * updates itself (spec #130, user story 41). An installer puts each version in
 * `<prefix>/app/<version>/` and points `<prefix>/current` at it, so the
 * service runs `<prefix>/app/<version>/service/attache-service.mjs`. A source
 * checkout, `pnpm dev` and the test runs never do.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface ReleaseInstall {
  /** The installation folder: it holds `app/<version>/` for each installed version and `current`. */
  prefix: string;
}

/** The release install the service script `script` belongs to, or null when it runs from anywhere else. */
export function releaseInstallOf(script: string | undefined, version: string): ReleaseInstall | null {
  if (!script || !/attache-service\.mjs$/.test(script)) return null;
  let real: string;
  try {
    real = realpathSync(script);
  } catch {
    // A script that is not there runs from nowhere an installer put it.
    return null;
  }
  const versionDir = dirname(dirname(real));
  const appDir = dirname(versionDir);
  const prefix = dirname(appDir);
  const versionFile = join(versionDir, "VERSION");
  const installed = existsSync(versionFile) && readFileSync(versionFile, "utf8").trim() === version;
  return installed && basename(appDir) === "app" && existsSync(join(prefix, "current")) ? { prefix } : null;
}
