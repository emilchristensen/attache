/**
 * The installer runner (spec #130, "Updater"): the one port through which an
 * Update is applied. It starts the staged release's own installer in
 * unattended mode, as a process of its own that outlives this service, and
 * returns once the installer is running. The installer then does what a
 * manual install does: it stops this service (the service exits as on any
 * stop, so running Jobs resume after the restart), switches versions, checks
 * the new one's health, and writes its outcome (`install-records.ts`).
 * The real adapter is per operating system (`platform/installer-runner.ts`);
 * service tests use a fake that records the request.
 */
export interface InstallRequest {
  /** The version installed now, and the version to install. */
  from: string;
  version: string;
  /** The staged release folder: the signed manifest, its signature and this computer's archive, verified. */
  release: string;
  /** The archive in `release` that holds the release's installer. */
  archive: string;
  /** The installation folder the new version goes into, and the Machine's state folder. */
  prefix: string;
  stateDir: string;
  /** The port the service answers on, which the installer keeps. */
  port: number;
}

export interface InstallerRunner {
  /** Start the installer for `request`; resolves once it runs on its own, rejects when it could not be started. */
  start(request: InstallRequest): Promise<void>;
}
