/**
 * A stand-in for the installer runner (spec #130, "Updater"): it records each
 * request instead of starting an installer, so a service test sees exactly
 * what the Updater handed over. `onStart` lets a test play the installer
 * (write its outcome record, restart the Machine on the new version).
 */
import type { InstallerRunner, InstallRequest } from "../../src/updates/installer-runner.ts";

export interface FakeInstallerRunner extends InstallerRunner {
  readonly requests: InstallRequest[];
  /** Runs after a request is recorded, as the installer would start then. */
  onStart: ((request: InstallRequest) => void | Promise<void>) | null;
}

export function fakeInstallerRunner(): FakeInstallerRunner {
  const runner: FakeInstallerRunner = {
    requests: [],
    onStart: null,
    async start(request) {
      runner.requests.push(request);
      // The real runner returns once the installer is started; the installer's work goes on without it.
      if (runner.onStart) void Promise.resolve(runner.onStart(request));
    },
  };
  return runner;
}
