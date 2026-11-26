/**
 * Check a release folder against its signed manifest: the folder holds the
 * manifest, its signature and the artifacts it names, as the release build
 * writes them and as the one-step installers unpack them. The signature is
 * checked before anything in the manifest is believed.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { manifestFileName, parseManifest, signatureFileName, type ReleaseArtifact, type ReleaseManifest } from "./manifest.ts";
import { signedByAny } from "./signature.ts";

/** Why a release was refused; the message is what the owner or the maintainer reads. */
export class ReleaseRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseRefusedError";
  }
}

export interface VerifyReleaseOptions {
  /** The public keys a signature may come from, as PEM text. */
  trustedKeys: readonly string[];
  /** The version the folder must hold; without it, the folder must hold exactly one manifest. */
  version?: string;
  /** The targets whose artifacts must be present and match; every target the manifest names when left out. */
  targets?: readonly string[];
}

export interface VerifiedRelease {
  manifest: ReleaseManifest;
  /** The artifacts that were present and matched, by target. */
  artifacts: Record<string, ReleaseArtifact>;
}

function findManifest(folder: string, version: string | undefined): string {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new ReleaseRefusedError(`${folder} is not a folder.`);
  if (version) return manifestFileName(version);
  const found = readdirSync(folder).filter((f) => /^attache-.+-manifest\.json$/.test(f));
  if (found.length === 1) return found[0]!;
  if (!found.length) throw new ReleaseRefusedError(`There is no release manifest in ${folder}.`);
  throw new ReleaseRefusedError(`${folder} holds the manifests of several releases (${found.join(", ")}); name the version to check.`);
}

/** A file's SHA-256 in hex, read as a stream, so a large artifact never sits in memory whole. */
export const sha256File = (file: string) =>
  new Promise<string>((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => resolve(h.digest("hex")))
      .on("error", reject);
  });

async function checkArtifact(folder: string, artifact: ReleaseArtifact): Promise<void> {
  const file = join(folder, artifact.name);
  if (!existsSync(file)) throw new ReleaseRefusedError(`${artifact.name} is missing from ${folder}.`);
  if (statSync(file).size !== artifact.size || (await sha256File(file)) !== artifact.sha256) throw new ReleaseRefusedError(`${artifact.name} does not match the signed manifest, so it was refused.`);
}

/**
 * The manifest these bytes hold, once `signatureText` proves a trusted key signed them;
 * a `ReleaseRefusedError` otherwise. `name` is the manifest's file name, for the message.
 * The signature is checked before the bytes are parsed, so nothing in them is believed before.
 */
export function verifySignedManifest(bytes: Uint8Array, signatureText: string, options: { trustedKeys: readonly string[]; version?: string; name: string }): ReleaseManifest {
  const { name } = options;
  if (!options.trustedKeys.length) throw new ReleaseRefusedError("This copy of Attache holds no release key, so it cannot check a release.");
  if (!signedByAny(bytes, signatureText, options.trustedKeys)) throw new ReleaseRefusedError(`${name} is not signed with Attache's key, so it was refused.`);
  let manifest: ReleaseManifest;
  try {
    manifest = parseManifest(bytes);
  } catch (e) {
    throw new ReleaseRefusedError((e as Error).message);
  }
  if (options.version && manifest.version !== options.version) throw new ReleaseRefusedError(`${name} describes Attache ${manifest.version}, not ${options.version}.`);
  return manifest;
}

/** The verified manifest, or a `ReleaseRefusedError` saying why the folder fails. */
export async function verifyReleaseFolder(folder: string, options: VerifyReleaseOptions): Promise<VerifiedRelease> {
  const name = findManifest(folder, options.version);
  const manifestFile = join(folder, name);
  const signatureFile = join(folder, options.version ? signatureFileName(options.version) : `${name}.sig`);
  if (!existsSync(manifestFile)) throw new ReleaseRefusedError(`${name} is missing from ${folder}.`);
  if (!existsSync(signatureFile)) throw new ReleaseRefusedError(`${name} has no signature next to it in ${folder}.`);
  const manifest = verifySignedManifest(readFileSync(manifestFile), readFileSync(signatureFile, "utf8"), { trustedKeys: options.trustedKeys, name, ...(options.version ? { version: options.version } : {}) });
  const targets = options.targets ?? Object.keys(manifest.artifacts);
  const artifacts: Record<string, ReleaseArtifact> = {};
  for (const target of targets) {
    const artifact = manifest.artifacts[target];
    if (!artifact) throw new ReleaseRefusedError(`Attache ${manifest.version} has no release for ${target}.`);
    await checkArtifact(folder, artifact);
    artifacts[target] = artifact;
  }
  return { manifest, artifacts };
}
