/**
 * A local stand-in for GitHub Releases: the release list the Updater reads
 * (`GET /repos/<owner>/<name>/releases`, newest first, Beta releases marked as
 * GitHub prereleases) and each release's files as downloadable assets.
 * Publish signed release folders from `signed-release.ts` into it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startFixtureServer, type FixtureRequest } from "./fixture-server.ts";
import type { SignedRelease } from "./signed-release.ts";

export interface PublishOptions {
  /** The tag; `v<version>` when left out. */
  tag?: string;
  /** Files of the folder left out of the release, as a release missing its signature is. */
  without?: string[];
}

export interface ReleaseServer {
  /** The address the Updater lists releases from: `updates.feedUrl` or `ATTACHE_RELEASE_FEED_URL`. */
  feedUrl: string;
  publish(version: string, release: SignedRelease, opts?: PublishOptions): void;
  /** Every request the server answered, so a test can see that none was made. */
  requests: FixtureRequest[];
  /** Answer every request with this HTTP status from now on, as a failing GitHub would; null answers again. */
  failWith(status: number | null): void;
  close(): Promise<void>;
}

const FEED_PATH = "/repos/emilchristensen/attache/releases";

export async function startReleaseServer(): Promise<ReleaseServer> {
  const fx = await startFixtureServer();
  const releases: Array<{ tag: string; version: string; files: Map<string, Buffer> }> = [];
  let failing: number | null = null;
  const failure = () => ({ status: failing!, json: { message: "Server Error" } });
  fx.route("GET", FEED_PATH, () =>
    failing
      ? failure()
      : {
          json: [...releases].reverse().map((r, i) => ({
            id: i + 1,
            tag_name: r.tag,
            name: `Attache ${r.version}`,
            draft: false,
            prerelease: r.version.includes("-"),
            assets: [...r.files.keys()].map((name) => ({ name, size: r.files.get(name)!.length, browser_download_url: `${fx.url}/download/${encodeURIComponent(r.tag)}/${encodeURIComponent(name)}` })),
          })),
        },
  );
  fx.route("GET", /^\/download\//, (req) => {
    if (failing) return failure();
    const [, , tag, name] = req.path.split("/").map(decodeURIComponent);
    const body = releases.find((r) => r.tag === tag)?.files.get(name!);
    return body ? { body } : { status: 404, text: "Not Found" };
  });
  return {
    feedUrl: `${fx.url}${FEED_PATH}`,
    requests: fx.requests,
    publish(version, release, opts = {}) {
      const files = new Map(
        readdirSync(release.folder)
          .filter((f) => !(opts.without ?? []).includes(f))
          .map((f) => [f, readFileSync(join(release.folder, f))] as const),
      );
      releases.push({ tag: opts.tag ?? `v${version}`, version, files });
    },
    failWith(status) {
      failing = status;
    },
    close: () => fx.close(),
  };
}
