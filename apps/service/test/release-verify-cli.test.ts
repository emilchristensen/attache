// `attache verify-release`, the internal command an installer runs with the installed version to check a new release.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "./helpers.ts";
import { signedRelease, testReleaseKeys } from "./fixtures/signed-release.ts";

// Each test starts the `attache` executable from source several times, which is slow while the whole suite runs in parallel.
vi.setConfig({ testTimeout: 120_000 });

const MAIN = join(import.meta.dirname, "../src/main.ts");

/**
 * The command from source, with `builtInKey` standing in for the public key the release build
 * puts into the bundle (there it is a constant the environment cannot change).
 */
function verifyRelease(args: string[], builtInKey: string | undefined, stateDir = tempDir("attache-verify-state-")) {
  const env = { ...process.env, ATTACHE_STATE_DIR: stateDir, ATTACHE_RELEASE_PUBLIC_KEY: builtInKey };
  if (!builtInKey) delete env.ATTACHE_RELEASE_PUBLIC_KEY;
  const r = spawnSync(process.execPath, [MAIN, "verify-release", ...args], { env, encoding: "utf8", timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("checking a release folder with the key this version holds", () => {
  it("accepts a release signed with the built-in key whose artifact for this target matches", () => {
    const key = testReleaseKeys();
    const release = signedRelease({ version: "0.7.0", key });
    const r = verifyRelease([release.folder, "--version", "0.7.0", "--target", "linux-x64"], key.publicKey);
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ verified: true, version: "0.7.0", channel: "stable", target: "linux-x64", artifact: "attache-0.7.0-linux-x64.tar.gz" });
  });

  it("refuses a release signed with any other key", () => {
    const release = signedRelease({ version: "0.7.0", key: testReleaseKeys() });
    const r = verifyRelease([release.folder, "--version", "0.7.0", "--target", "linux-x64"], testReleaseKeys().publicKey);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("attache-0.7.0-manifest.json is not signed with Attache's key");
  });

  it("refuses a release whose artifact for this target differs from the manifest, even when the others match", () => {
    const key = testReleaseKeys();
    const release = signedRelease({ version: "0.7.0-beta.2", key });
    writeFileSync(release.artifacts["windows-x64"]!, "swapped");
    const r = verifyRelease([release.folder, "--version", "0.7.0-beta.2", "--target", "windows-x64"], key.publicKey);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("attache-0.7.0-beta.2-windows-x64.zip does not match the signed manifest");
    expect(verifyRelease([release.folder, "--version", "0.7.0-beta.2", "--target", "linux-x64"], key.publicKey).status).toBe(0);
  });

  it("refuses a folder that holds another version than the one being installed", () => {
    const key = testReleaseKeys();
    const release = signedRelease({ version: "0.7.0", key });
    const r = verifyRelease([release.folder, "--version", "0.8.0", "--target", "linux-x64"], key.publicKey);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("attache-0.8.0-manifest.json is missing");
  });

  it("refuses everything when this copy holds no release key", () => {
    const release = signedRelease({ version: "0.7.0", key: testReleaseKeys() });
    const r = verifyRelease([release.folder, "--version", "0.7.0", "--target", "linux-x64"], undefined);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("holds no release key");
  });

  it("answers the installer's question whether it can check releases at all", () => {
    expect(verifyRelease(["--supported"], undefined).status).toBe(0);
  });
});

describe("rotating the release key", () => {
  it("trusts the next key a release signed with a trusted key names, and keeps it in the Machine's state", () => {
    const current = testReleaseKeys();
    const next = testReleaseKeys();
    const stateDir = tempDir("attache-verify-state-");
    const signedByNext = signedRelease({ version: "0.9.0", key: next });
    const args = (v: string, folder: string) => [folder, "--version", v, "--target", "linux-x64"];

    expect(verifyRelease(args("0.9.0", signedByNext.folder), current.publicKey, stateDir).status).toBe(1);

    const naming = signedRelease({ version: "0.8.0", key: current, nextPublicKey: next.publicKey });
    expect(verifyRelease(args("0.8.0", naming.folder), current.publicKey, stateDir).status).toBe(0);
    expect(verifyRelease(args("0.9.0", signedByNext.folder), current.publicKey, stateDir).status).toBe(0);
    // Another Machine that never saw 0.8.0's manifest does not trust the next key.
    expect(verifyRelease(args("0.9.0", signedByNext.folder), current.publicKey).status).toBe(1);
  });

  it("never trusts a next key named by a manifest whose signature fails", () => {
    const current = testReleaseKeys();
    const attacker = testReleaseKeys();
    const stateDir = tempDir("attache-verify-state-");
    const forged = signedRelease({ version: "0.8.0", key: attacker, nextPublicKey: attacker.publicKey });
    expect(verifyRelease([forged.folder, "--version", "0.8.0", "--target", "linux-x64"], current.publicKey, stateDir).status).toBe(1);
    const signedByAttacker = signedRelease({ version: "0.9.0", key: attacker });
    expect(verifyRelease([signedByAttacker.folder, "--version", "0.9.0", "--target", "linux-x64"], current.publicKey, stateDir).status).toBe(1);
  });

  it("never trusts a next key named by a release whose artifact does not match", () => {
    const current = testReleaseKeys();
    const next = testReleaseKeys();
    const stateDir = tempDir("attache-verify-state-");
    const naming = signedRelease({ version: "0.8.0", key: current, nextPublicKey: next.publicKey });
    writeFileSync(naming.artifacts["linux-x64"]!, readFileSync(naming.artifacts["linux-x64"]!, "utf8") + "!");
    expect(verifyRelease([naming.folder, "--version", "0.8.0", "--target", "linux-x64"], current.publicKey, stateDir).status).toBe(1);
    const signedByNext = signedRelease({ version: "0.9.0", key: next });
    expect(verifyRelease([signedByNext.folder, "--version", "0.9.0", "--target", "linux-x64"], current.publicKey, stateDir).status).toBe(1);
  });
});
