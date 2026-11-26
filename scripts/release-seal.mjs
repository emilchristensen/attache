/**
 * Seal a release folder (ADR 0007): write the manifest of the archives built
 * into it, sign it, write each target's one-step installer carrying the
 * manifest, its signature and the archive, and list every file in
 * `SHA256SUMS`. Building another target into the folder seals it again, so
 * the manifest and every installer always cover every archive in it.
 */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { manifestFileName, signatureFileName, writeManifest } from "../apps/service/src/release/manifest.ts";
import { publicKeyOf, samePublicKey, signBytes } from "../apps/service/src/release/signature.ts";
import { sha256File } from "../apps/service/src/release/verify-release.ts";
import { oneStepInstaller } from "./release-installers.mjs";
import { RELEASE_TARGETS, releaseArchive } from "./release-targets.mjs";

/** Refuse a signing key that does not belong to the public key built into the release: it could never verify. */
export function assertKeyPair(signingKey, publicKey) {
  if (!samePublicKey(publicKeyOf(signingKey), publicKey)) throw new Error("The signing key does not belong to the public key given to the build, so the release could not verify itself. Pass the matching pair.");
}

/**
 * @param {{ folder: string, version: string, signingKey: string, publicKey: string, notes?: string, nextPublicKey?: string, publishedAt?: Date }} release
 *   keys as PEM text; `notes` is the release notes in Markdown.
 */
export async function sealRelease({ folder, version, signingKey, publicKey, notes = "", nextPublicKey, publishedAt = new Date() }) {
  assertKeyPair(signingKey, publicKey);
  const targets = Object.keys(RELEASE_TARGETS).filter((t) => existsSync(join(folder, releaseArchive(version, t))));
  if (!targets.length) throw new Error(`There is no Attache ${version} archive in ${folder} to seal.`);
  const artifacts = {};
  for (const target of targets) {
    const name = releaseArchive(version, target);
    artifacts[target] = { name, size: statSync(join(folder, name)).size, sha256: await sha256File(join(folder, name)) };
  }
  const manifest = writeManifest({ version, publishedAt, notes, artifacts, ...(nextPublicKey ? { nextPublicKey } : {}) });
  const signature = Buffer.from(signBytes(manifest, signingKey));
  writeFileSync(join(folder, manifestFileName(version)), manifest);
  writeFileSync(join(folder, signatureFileName(version)), signature);

  const files = [manifestFileName(version), signatureFileName(version)];
  for (const target of targets) {
    const installer = RELEASE_TARGETS[target].installer(version);
    writeFileSync(join(folder, installer), oneStepInstaller({ version, target, manifest, signature, archive: readFileSync(join(folder, artifacts[target].name)) }));
    chmodSync(join(folder, installer), 0o755);
    files.push(artifacts[target].name, installer);
  }
  const lines = [];
  for (const f of files.sort()) lines.push(`${await sha256File(join(folder, f))}  ${f}`);
  writeFileSync(join(folder, "SHA256SUMS"), lines.join("\n") + "\n");
  return { manifest: join(folder, manifestFileName(version)), targets };
}
