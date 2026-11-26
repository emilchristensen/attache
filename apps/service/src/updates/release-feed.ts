/**
 * The release feed (spec #130, "Release feed client"): the repository's GitHub
 * releases, Beta releases included, read without signing in. Nothing read
 * here is trusted: a release counts only once its manifest's signature
 * verifies (`find-update.ts`), so pointing the feed elsewhere grants nothing.
 */
import { createHttpClient, type HttpClient } from "../connectors/http.ts";
import { z } from "zod";

/** Where releases are listed: GitHub, or `ATTACHE_RELEASE_FEED_URL` (tests and the install test point it at a local server). */
export const DEFAULT_RELEASE_FEED = "https://api.github.com/repos/emilchristensen/attache/releases";
export const releaseFeedUrl = (): string => process.env.ATTACHE_RELEASE_FEED_URL || DEFAULT_RELEASE_FEED;

/** One release as the feed lists it: its tag and its downloadable files by name. */
export interface FeedRelease {
  tag: string;
  /** Each file's download address, by file name. */
  assets: ReadonlyMap<string, string>;
}

const GitHubRelease = z.object({
  tag_name: z.string(),
  draft: z.boolean().default(false),
  assets: z.array(z.object({ name: z.string(), browser_download_url: z.string() })).default([]),
});

/** GitHub lists at most this many releases on a page; the newest page is all a check needs. */
const PER_PAGE = 100;

export class ReleaseFeed {
  readonly url: string;
  private readonly http: HttpClient;

  constructor(url: string, userAgent: string) {
    this.url = url;
    // One retry: a check runs again at the next one anyway, and a failure must reach the owner without a long wait.
    this.http = createHttpClient({ userAgent, baseDelayMs: 500 });
  }

  /** The address's host, as the owner reads it in a failure. */
  get host(): string {
    return new URL(this.url).host;
  }

  /** The published releases, newest first as GitHub lists them; drafts and entries Attache cannot read are left out. */
  async releases(): Promise<FeedRelease[]> {
    const url = new URL(this.url);
    url.searchParams.set("per_page", String(PER_PAGE));
    const res = await this.http.request<unknown>({ url: url.toString(), headers: { accept: "application/vnd.github+json" }, retries: 1, timeoutMs: 30_000 });
    if (!Array.isArray(res.data)) throw new Error(`The release list from ${this.host} is not a list of releases.`);
    return res.data.flatMap((entry) => {
      const r = GitHubRelease.safeParse(entry);
      if (!r.success || r.data.draft) return [];
      return [{ tag: r.data.tag_name, assets: new Map(r.data.assets.map((a) => [a.name, a.browser_download_url])) }];
    });
  }

  /** A release file's exact bytes. */
  async download(url: string): Promise<Buffer> {
    const res = await this.http.request<Buffer>({ url, headers: { accept: "application/octet-stream" }, responseType: "bytes", retries: 1, timeoutMs: 60_000 });
    return res.data;
  }
}
