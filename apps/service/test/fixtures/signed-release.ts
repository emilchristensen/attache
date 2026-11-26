/**
 * Release folders signed with a test key, laid out as the release build writes
 * them: the manifest, its signature and one artifact per target. The artifacts
 * are small stand-ins; what matters is that their bytes match the manifest.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestFileName, signatureFileName, writeManifest } from "../../src/release/manifest.ts";
import { generateReleaseKeyPair, signBytes, type ReleaseKeyPair } from "../../src/release/signature.ts";

export const testReleaseKeys = (): ReleaseKeyPair => generateReleaseKeyPair();

export interface SignedRelease {
  folder: string;
  manifest: string;
  signature: string;
  /** Each target's artifact file. */
  artifacts: Record<string, string>;
}

export function signedRelease(opts: { version: string; key: ReleaseKeyPair; targets?: string[]; nextPublicKey?: string; notes?: string }): SignedRelease {
  const folder = mkdtempSync(join(tmpdir(), `attache-release-${opts.version}-`));
  const files: Record<string, string> = {};
  const entries = (opts.targets ?? ["macos-arm64", "linux-x64", "windows-x64"]).map((target) => {
    const name = `attache-${opts.version}-${target}.${target.startsWith("windows") ? "zip" : "tar.gz"}`;
    const bytes = Buffer.from(`Attache ${opts.version} for ${target}`);
    files[target] = join(folder, name);
    writeFileSync(files[target], bytes);
    return [target, { name, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }] as const;
  });
  const manifest = writeManifest({
    version: opts.version,
    publishedAt: new Date("2026-11-26T09:00:00Z"),
    notes: opts.notes ?? `## ${opts.version}\n\nWhat changed.\n`,
    artifacts: Object.fromEntries(entries),
    ...(opts.nextPublicKey ? { nextPublicKey: opts.nextPublicKey } : {}),
  });
  const manifestFile = join(folder, manifestFileName(opts.version));
  const signatureFile = join(folder, signatureFileName(opts.version));
  writeFileSync(manifestFile, manifest);
  writeFileSync(signatureFile, signBytes(manifest, opts.key.privateKey));
  return { folder, manifest: manifestFile, signature: signatureFile, artifacts: files };
}
