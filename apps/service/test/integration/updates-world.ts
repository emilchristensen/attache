/**
 * Machines installed from a release, and a local stand-in for GitHub Releases
 * with releases signed by a test key. Call `updatesWorld()` at the top of a
 * test file: it makes the test key this copy's built-in key for the file and
 * closes what each test opened.
 */
import { afterAll, afterEach, beforeAll } from "vitest";
import { signedRelease, testReleaseKeys } from "../fixtures/signed-release.ts";
import { startReleaseServer, type ReleaseServer } from "../fixtures/release-server.ts";
import { startTestService, testFolder, type TestService } from "./harness.ts";

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

  return {
    key,
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
    /** A Machine running `version` that reads releases from `server`: a release install, or a source checkout with `releaseInstall: false`. */
    async machine(version: string, server: ReleaseServer, opts: { releaseInstall?: boolean } = {}): Promise<TestService> {
      const svc = await startTestService({ version, updates: { feedUrl: server.feedUrl, releaseInstall: opts.releaseInstall === false ? null : { prefix: testFolder("prefix") } } });
      open.push(() => svc.stop());
      return svc;
    },
  };
}
