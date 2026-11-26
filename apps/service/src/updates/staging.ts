/**
 * Staging an Update (spec #130, "Release feed client"): the release's signed
 * manifest, its signature and this computer's archive go into
 * `<state>/updates/staging/<version>/`, a release folder like the one the
 * release build writes, and the whole folder is checked as an installer
 * checks it: the signature, then the archive's size and SHA-256. Nothing else
 * is ever kept there: staging an Update removes whatever it supersedes, and a
 * release that fails the check leaves nothing behind.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { manifestFileName, signatureFileName, type ReleaseManifest } from "../release/manifest.ts";
import { keepNextReleaseKey } from "../release/trusted-keys.ts";
import { ReleaseRefusedError, verifyReleaseFolder } from "../release/verify-release.ts";
import type { FoundUpdate } from "./find-update.ts";
import { stagingDir } from "./install-records.ts";
import type { ReleaseFeed } from "./release-feed.ts";

export interface StagedUpdate {
  manifest: ReleaseManifest;
  /** The release folder, and the archive in it. */
  folder: string;
  archive: string;
}

export interface StageInput {
  feed: ReleaseFeed;
  found: FoundUpdate;
  target: string;
  stateDir: string;
  trustedKeys: readonly string[];
  /** Aborts once the download is no longer wanted: it stops and makes no retry. */
  signal?: AbortSignal;
}

/** Remove every staged release; one still in use (a Windows installer that is just exiting) stays for the next time. */
export function clearStaging(stateDir: string, keep?: string): string[] {
  const root = stagingDir(stateDir);
  const left: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).filter((e) => e.name !== keep)) {
    try {
      rmSync(join(root, entry.name), { recursive: true, force: true });
    } catch {
      // Removed on the next Update or start instead; the caller logs which.
      left.push(entry.name);
    }
  }
  return left;
}

/**
 * Download the found Update's archive for `target` next to its signed manifest and check the folder.
 * Throws `ReleaseRefusedError` when the archive is missing or does not match the manifest; a download that fails throws as the feed does.
 */
export async function stageUpdate(input: StageInput): Promise<StagedUpdate> {
  const { manifest } = input.found;
  const artifact = manifest.artifacts[input.target];
  if (!artifact) throw new ReleaseRefusedError(`Attache ${manifest.version} has no release for ${input.target}.`);
  const url = input.found.assets.get(artifact.name);
  if (!url) throw new ReleaseRefusedError(`${artifact.name} is missing from Attache ${manifest.version}'s release, so it was refused.`);
  mkdirSync(stagingDir(input.stateDir), { recursive: true, mode: 0o700 });
  clearStaging(input.stateDir);
  const folder = join(stagingDir(input.stateDir), manifest.version);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  try {
    writeFileSync(join(folder, manifestFileName(manifest.version)), input.found.signed.manifest);
    writeFileSync(join(folder, signatureFileName(manifest.version)), input.found.signed.signature);
    const archive = join(folder, artifact.name);
    await input.feed.downloadTo(url, archive, artifact.size, input.signal);
    const verified = await verifyReleaseFolder(folder, { trustedKeys: input.trustedKeys, version: manifest.version, targets: [input.target] });
    // The whole release checked out, so a next key it names is one this Machine may trust from now on (ADR 0007).
    keepNextReleaseKey(input.stateDir, verified.manifest);
    return { manifest: verified.manifest, folder, archive };
  } catch (e) {
    rmSync(folder, { recursive: true, force: true });
    throw e;
  }
}
