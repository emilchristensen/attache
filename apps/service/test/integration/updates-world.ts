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
import { mkdirSync, writeFileSync } from "node:fs";
import type { UpdatesView } from "@attache/contracts";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll } from "vitest";
import { signedRelease, testReleaseKeys } from "../fixtures/signed-release.ts";
import { startReleaseServer, type ReleaseServer } from "../fixtures/release-server.ts";
import { fakeInstallerRunner, type FakeInstallerRunner } from "../fixtures/fake-installer-runner.ts";
import { eventually } from "../helpers.ts";
import { ManualClock } from "../fixtures/manual-clock.ts";
import { startTestService, testFolder, type TestService } from "./harness.ts";

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
}

/** What the installer leaves in the Machine's state when it finishes (`<state>/updates/outcome.json`), written as the installers write it. */
export function installerFinished(
  stateDir: string,
  outcome: { outcome: "updated" | "rolled_back" | "failed"; from: string; to: string; reason?: string; database?: "restored" | "no_backup" | "restore_failed"; backup?: string },
): void {
  mkdirSync(join(stateDir, "updates"), { recursive: true });
  writeFileSync(join(stateDir, "updates", "outcome.json"), JSON.stringify({ ...outcome, at: new Date().toISOString() }) + "\n");
}

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
   * Its installer runner only records what it is asked; `stateDir`, `prefix` and `startAt` continue an earlier Machine, as a restart does.
   */
  async function machine(version: string, server: ReleaseServer, opts: { releaseInstall?: boolean; stateDir?: string; prefix?: string; runner?: FakeInstallerRunner; startAt?: number } = {}): Promise<UpdatesMachine> {
    const runner = opts.runner ?? fakeInstallerRunner();
    const releaseInstall = opts.releaseInstall === false ? null : { prefix: opts.prefix ?? testFolder("prefix") };
    const clock = new ManualClock(opts.startAt);
    const svc = await startTestService({ version, clock, ...(opts.stateDir ? { stateDir: opts.stateDir } : {}), updates: { feedUrl: server.feedUrl, releaseInstall, installerRunner: runner } });
    const stop = svc.stop;
    let stopped = false;
    const m: UpdatesMachine = Object.assign(svc, {
      runner,
      releaseServer: server,
      prefix: releaseInstall?.prefix ?? null,
      clock,
      async stop() {
        if (stopped) return;
        stopped = true;
        await stop();
      },
    });
    open.push(() => m.stop());
    return m;
  }

  return {
    key,
    machine,
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
      for (const version of versions) server.publish(version, signedRelease({ version, key, notes: `## ${version}\n\nWhat changed in ${version}.\n` }));
      return server;
    },
    /** Stop `m` and start it again on `version`, as the installer does when it switches versions. Its clock goes on from where `m`'s stood. */
    async restart(m: UpdatesMachine, version: string): Promise<UpdatesMachine> {
      await m.stop();
      return machine(version, m.releaseServer, { stateDir: m.stateDir, runner: m.runner, startAt: m.clock.now().getTime(), ...(m.prefix ? { prefix: m.prefix } : { releaseInstall: false }) });
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
