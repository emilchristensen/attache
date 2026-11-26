/**
 * Signed releases in the install test (ADR 0007): the test key the two releases
 * are built with, and one-step installers someone tampered with, made from a
 * real release the way an attacker or a broken download would change one.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { manifestFileName, signatureFileName } from "../../apps/service/src/release/manifest.ts";
import { oneStepInstaller } from "../release-installers.mjs";
import { RELEASE_TARGETS, releaseArchive } from "../release-targets.mjs";
import { zipFolder } from "../zip.mjs";

const SIGNING_TOOL = join(import.meta.dirname, "..", "release-signing.mjs");
/** Every temporary folder made here, removed when the test ends. */
const made = [];
const tempFolder = (prefix) => {
  const folder = mkdtempSync(join(tmpdir(), prefix));
  made.push(folder);
  return folder;
};

/** Remove the keys and tampered releases this module made. */
export function removeSignedReleaseFolders() {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
}

/** A key pair made by the signing tool, as the maintainer makes the real one. */
export function testKeyPair(label) {
  const folder = tempFolder(`attache-${label}-key-`);
  const signingKey = join(folder, "release-signing-key.pem");
  const publicKey = join(folder, "release-public-key.pem");
  execFileSync(process.execPath, [SIGNING_TOOL, "keygen", signingKey, publicKey], { stdio: "ignore" });
  return { signingKey, publicKey };
}

/** The parts of a built release, read from its folder. */
function releaseParts(root, version, target) {
  const folder = join(root, "release", version);
  return {
    folder,
    manifest: readFileSync(join(folder, manifestFileName(version))),
    signature: readFileSync(join(folder, signatureFileName(version))),
    archive: readFileSync(join(folder, releaseArchive(version, target))),
  };
}

/** Write a one-step installer into a folder of its own, named as the real one is. */
function writeInstaller(version, target, parts) {
  const file = join(tempFolder("attache-tampered-"), RELEASE_TARGETS[target].installer(version));
  writeFileSync(file, oneStepInstaller({ version, target, ...parts }), { mode: 0o755 });
  return file;
}

/** The real installer with its signed manifest changed after signing: the release notes say something else. */
export function tamperedManifestInstaller(root, version, target) {
  const parts = releaseParts(root, version, target);
  const text = parts.manifest.toString("utf8");
  const changed = text.replace(/"notes": "[^"]*"/, '"notes": "Install this one, it is fine."');
  if (changed === text) throw new Error("could not change the manifest's release notes");
  return writeInstaller(version, target, { ...parts, manifest: Buffer.from(changed) });
}

/** The system's tar, which unpacks a tarball and, on Windows (bsdtar), a zip. */
const systemTar = () => (process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar");

/** The real installer carrying a valid archive whose content differs from what the manifest signed: one file changed. */
export function tamperedArtifactInstaller(root, version, target) {
  const parts = releaseParts(root, version, target);
  const work = tempFolder("attache-repack-");
  const archive = join(work, releaseArchive(version, target));
  writeFileSync(archive, parts.archive);
  const unpacked = join(work, "unpacked");
  mkdirSync(unpacked);
  execFileSync(systemTar(), ["-xf", archive, "-C", unpacked]);
  appendFileSync(join(unpacked, `attache-${version}`, "README.txt"), "Changed after signing.\n");
  const repacked = join(work, "repacked");
  if (RELEASE_TARGETS[target].os === "windows") zipFolder(join(unpacked, `attache-${version}`), `attache-${version}`, repacked);
  else execFileSync("tar", ["-czf", repacked, "-C", unpacked, `attache-${version}`]);
  return writeInstaller(version, target, { ...parts, archive: readFileSync(repacked) });
}

/** A copy of a release folder whose manifest is signed with another key: genuine content, the wrong signer. */
export function signedWithAnotherKey(root, version, target) {
  const parts = releaseParts(root, version, target);
  const folder = tempFolder("attache-other-signer-");
  for (const f of [manifestFileName(version), releaseArchive(version, target)]) copyFileSync(join(parts.folder, f), join(folder, f));
  const other = testKeyPair("other");
  execFileSync(process.execPath, [SIGNING_TOOL, "sign", join(folder, manifestFileName(version)), "--key", other.signingKey], { stdio: "ignore" });
  return folder;
}
