/**
 * Find the Update a Machine may take: the newest release in its Update channel,
 * newer than the version it runs and not marked bad here, whose manifest is
 * signed with a key this Machine trusts (ADR 0007). The manifest and its
 * signature are downloaded and verified before anything in them is believed;
 * the artifact is not downloaded here.
 */
import type { UpdateChannel } from "@attache/contracts";
import { RemoteError } from "../connectors/http.ts";
import { manifestFileName, signatureFileName, type ReleaseManifest } from "../release/manifest.ts";
import { ReleaseRefusedError, verifySignedManifest } from "../release/verify-release.ts";
import { eligibleVersions, tagVersion } from "./channel.ts";
import type { FeedRelease, ReleaseFeed } from "./release-feed.ts";

/** A check that did not finish; the message is what the owner reads. */
export class UpdateCheckError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UpdateCheckError";
  }
}

export interface FindUpdateInput {
  feed: ReleaseFeed;
  installed: string;
  channel: UpdateChannel;
  bad: readonly string[];
  trustedKeys: readonly string[];
  /** This computer's release target: a release without an artifact for it is not an Update here. */
  target: string;
  /** Told about each newer release that was refused, with the reason. */
  refused?: (version: string, reason: string) => void;
}

/** An Update a check found: its verified manifest, the exact bytes that were verified, and the release's files. */
export interface FoundUpdate {
  manifest: ReleaseManifest;
  /** The manifest's exact bytes and its signature, as the release carries them, so a staged copy verifies again. */
  signed: { manifest: Buffer; signature: string };
  /** The release's files by name: the artifact for this computer is downloaded from here. */
  assets: ReadonlyMap<string, string>;
}

/** What the owner reads when the feed could not be read. */
export function unreachable(feed: ReleaseFeed, e: unknown): UpdateCheckError {
  if (e instanceof RemoteError) {
    if (e.state === "offline" && e.status === null) return new UpdateCheckError(`Could not reach ${feed.host} to look for an Update. Check the network connection, then check again.`, { cause: e });
    if (e.state === "partial") return new UpdateCheckError(`${feed.host} turned the check away for now (rate limit). Check again later.`, { cause: e });
    if (e.status !== null) return new UpdateCheckError(`${feed.host} answered HTTP ${e.status} when Attache looked for an Update. Check again later.`, { cause: e });
  }
  return new UpdateCheckError(`Could not look for an Update at ${feed.host}: ${(e as Error).message}`, { cause: e });
}

async function verifiedManifest(input: FindUpdateInput, release: FeedRelease, version: string): Promise<FoundUpdate> {
  const name = manifestFileName(version);
  const manifestUrl = release.assets.get(name);
  const signatureUrl = release.assets.get(signatureFileName(version));
  if (!manifestUrl) throw new ReleaseRefusedError(`${name} is missing from Attache ${version}'s release, so it was refused.`);
  if (!signatureUrl) throw new ReleaseRefusedError(`${name} has no signature in Attache ${version}'s release, so it was refused.`);
  let bytes: Buffer;
  let signature: Buffer;
  try {
    [bytes, signature] = await Promise.all([input.feed.download(manifestUrl), input.feed.download(signatureUrl)]);
  } catch (e) {
    throw unreachable(input.feed, e);
  }
  const signatureText = signature.toString("utf8");
  const manifest = verifySignedManifest(bytes, signatureText, { trustedKeys: input.trustedKeys, version, name });
  return { manifest, signed: { manifest: bytes, signature: signatureText }, assets: release.assets };
}

/**
 * The Update to take, with its verified manifest, or null when the Machine is up to date.
 * Throws `UpdateCheckError` when the feed cannot be read, or when newer releases exist but every one was refused:
 * a refused release never looks like being up to date.
 */
export async function findUpdate(input: FindUpdateInput): Promise<FoundUpdate | null> {
  let listed: FeedRelease[];
  try {
    listed = await input.feed.releases();
  } catch (e) {
    throw unreachable(input.feed, e);
  }
  const byVersion = new Map(listed.map((r) => [tagVersion(r.tag), r]));
  let firstRefusal: string | null = null;
  for (const version of eligibleVersions(listed.map((r) => r.tag), input)) {
    try {
      const found = await verifiedManifest(input, byVersion.get(version)!, version);
      // A release without a build for this computer is not an Update here, nor a fault.
      if (found.manifest.artifacts[input.target]) return found;
    } catch (e) {
      if (!(e instanceof ReleaseRefusedError)) throw e;
      input.refused?.(version, e.message);
      firstRefusal ??= e.message;
    }
  }
  if (firstRefusal) throw new UpdateCheckError(firstRefusal);
  return null;
}
