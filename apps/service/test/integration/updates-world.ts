/**
 * Machines installed from a release, and a local stand-in for GitHub Releases
 * with releases signed by a test key. Call `updatesWorld()` at the top of a
 * test file: it makes the test key this copy's built-in key for the file and
 * closes what each test opened.
 *
 * Each Machine runs on a `ManualClock`: the Updater's timers (the check at
 * start and every 6 hours, the look at running Jobs every minute, the watch
 * for the installer's outcome) fire only when a test moves the clock, so a
 * test that only calls the API sees a Machine where no time has passed.
 */
import type { UpdatesView } from "@attache/contracts";
import { afterAll, afterEach, beforeAll } from "vitest";
import { signedRelease, testReleaseKeys } from "../fixtures/signed-release.ts";
import { startReleaseServer, type ReleaseServer } from "../fixtures/release-server.ts";
import { fakeInstallerRunner, type FakeInstallerRunner } from "../fixtures/fake-installer-runner.ts";
import { eventually } from "../helpers.ts";
import { ManualClock } from "../fixtures/manual-clock.ts";
import { recordingNotifier, type RecordingNotifier } from "../fixtures/recording-notifier.ts";
import { startTestService, testFolder, type TestService, type TestServiceOptions } from "./harness.ts";

/** How often the Updater looks for the installer's outcome (`OUTCOME_POLL_MS` in `updater.ts`). */
const OUTCOME_POLL_MS = 1_000;

export interface UpdatesMachine extends TestService {
  /** What the Updater handed to the installer runner. */
  runner: FakeInstallerRunner;
  /** The release server this Machine reads. */
  releaseServer: ReleaseServer;
  /** Its installation folder; null for a source checkout. */
  prefix: string | null;
  /** Its clock: time passes for the Updater only when the test advances it. */
  clock: ManualClock;
  /** The desktop notifications it raised, kept across `restart`, as the owner's computer keeps them. */
  notifications: RecordingNotifier;
}

export { installerFinished } from "../fixtures/installer-outcome.ts";

export function updatesWorld() {
  // The key this copy is built with: a constant in a release bundle, read from the environment when run from source.
  const key = testReleaseKeys();
  const previousKey = process.env.ATTACHE_RELEASE_PUBLIC_KEY;
  beforeAll(() => {
    process.env.ATTACHE_RELEASE_PUBLIC_KEY = key.publicKey;
  });
  afterAll(() => {
    if (previousKey === undefined) delete process.env.ATTACHE_RELEASE_PUBLIC_KEY;
    else process.env.ATTACHE_RELEASE_PUBLIC_KEY = previousKey;
  });
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of open.splice(0)) await close();
  });

  /**
   * A Machine running `version` that reads releases from `server`: a release install, or a source checkout with `releaseInstall: false`.
   * Its installer runner only records what it is asked, and its desktop notifications are recorded; `stateDir`, `prefix` and `startAt` continue an earlier Machine, as a restart does.
   * `setup: false` leaves it without a data folder, to join a Brain; `brainFormat` is what its release reads and writes (`TestServiceOptions`).
   */
  async function machine(version: string, server: ReleaseServer, opts: { releaseInstall?: boolean; stateDir?: string; prefix?: string; runner?: FakeInstallerRunner; notifications?: RecordingNotifier; startAt?: number } & Pick<TestServiceOptions, "setup" | "brainFormat"> = {}): Promise<UpdatesMachine> {
    const runner = opts.runner ?? fakeInstallerRunner();
    const releaseInstall = opts.releaseInstall === false ? null : { prefix: opts.prefix ?? testFolder("prefix") };
    const clock = new ManualClock(opts.startAt);
    const notifications = opts.notifications ?? recordingNotifier();
    const svc = await startTestService({
      version,
      clock,
      notifier: notifications,
      ...(opts.stateDir ? { stateDir: opts.stateDir } : {}),
      ...(opts.setup === false ? { setup: false } : {}),
      ...(opts.brainFormat ? { brainFormat: opts.brainFormat } : {}),
      updates: { feedUrl: server.feedUrl, releaseInstall, installerRunner: runner },
    });
    const stop = svc.stop;
    let stopped = false;
    const m: UpdatesMachine = Object.assign(svc, {
      runner,
      releaseServer: server,
      prefix: releaseInstall?.prefix ?? null,
      clock,
      notifications,
      async stop() {
        if (stopped) return;
        stopped = true;
        await stop();
      },
    });
    open.push(() => m.stop());
    return m;
  }

  /** Publish these versions on `server`, each signed with the built-in key, oldest first. */
  function publish(server: ReleaseServer, ...versions: string[]): void {
    for (const version of versions) server.publish(version, signedRelease({ version, key, notes: `## ${version}\n\nWhat changed in ${version}.\n` }));
  }

  return {
    key,
    machine,
    publish,
    /** A release server with these versions published, each signed with the built-in key, oldest first. */
    async releases(...versions: string[]): Promise<ReleaseServer> {
      const server = await startReleaseServer();
      let closed = false;
      const close = server.close;
      server.close = async () => {
        if (closed) return;
        closed = true;
        await close();
      };
      open.push(() => server.close());
      publish(server, ...versions);
      return server;
    },
    /**
     * Stop `m` and start it again on `version`, as the installer does when it switches versions. Its clock goes on from where `m`'s stood.
     * `brainFormat` is what the release it runs from now on reads and writes.
     */
    async restart(m: UpdatesMachine, version: string, opts: Pick<TestServiceOptions, "brainFormat"> = {}): Promise<UpdatesMachine> {
      await m.stop();
      return machine(version, m.releaseServer, { stateDir: m.stateDir, runner: m.runner, notifications: m.notifications, startAt: m.clock.now().getTime(), ...(m.prefix ? { prefix: m.prefix } : { releaseInstall: false }), ...opts });
    },
    /** Let the Machine's clock run until the Updater has read the outcome the installer left, as it does once a second. */
    async outcomeSeen(m: UpdatesMachine): Promise<void> {
      await eventually("the Updater to read the installer's outcome", async () => {
        await m.clock.advance(OUTCOME_POLL_MS);
        return (await m.get<UpdatesView>("/updates")).lastUpdate;
      });
    },
  };
}
