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

/** What updating takes on a Machine that can update itself. */
export interface CanUpdate {
  /** The installation folder the installer writes to. */
  prefix: string;
  /** This computer's release target (`platform/release-target.ts`). */
  target: string;
  /** The keys a release manifest's signature may come from (`release/trusted-keys.ts`). */
  trustedKeys: readonly string[];
}

/**
 * Whether this copy can update itself, with what that takes, or why not: a source checkout, a computer Attache has no
 * release for, or a build without a release key.
 */
export function canUpdate(from: { install: ReleaseInstall | null; target: string | null; trustedKeys: readonly string[] }): CanUpdate | { unavailable: string } {
  if (!from.install) return { unavailable: "Attache runs from a source checkout here, so it does not update itself. Pull the newest code and build it instead." };
  if (!from.target) return { unavailable: `There is no Attache release for ${process.platform}/${process.arch}, so this Machine cannot update itself.` };
  if (!from.trustedKeys.length) return { unavailable: "This copy of Attache holds no release key, so it cannot check an Update. Install a release from GitHub by hand." };
  return { prefix: from.install.prefix, target: from.target, trustedKeys: from.trustedKeys };
}
