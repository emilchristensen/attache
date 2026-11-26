// The signing tool (scripts/release-signing.mjs), driven as the maintainer and the release workflow run it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const TOOL = join(import.meta.dirname, "..", "release-signing.mjs");

function tool(...args: string[]) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: "utf8" });
  return { status: r.status, out: r.stdout, err: r.stderr };
}

/** A fresh key pair made by the tool, in its own folder. */
function keyPair(folder = mkdtempSync(join(tmpdir(), "attache-keys-"))) {
  const privateKey = join(folder, "release-signing-key.pem");
  const publicKey = join(folder, "release-public-key.pem");
  const r = tool("keygen", privateKey, publicKey);
  expect(r.status, r.err).toBe(0);
  return { privateKey, publicKey };
}

const ARCHIVE = "attache-0.7.0-linux-x64.tar.gz";
const ARCHIVE_BYTES = Buffer.from("not really a tarball, but bytes all the same");

/** A release folder with one artifact and a manifest that names it, not yet signed. */
function releaseFolder() {
  const folder = mkdtempSync(join(tmpdir(), "attache-release-"));
  writeFileSync(join(folder, ARCHIVE), ARCHIVE_BYTES);
  const manifest = {
    manifestVersion: 1,
    version: "0.7.0",
    channel: "stable",
    publishedAt: "2026-11-26T09:00:00.000Z",
    notes: "## 0.7.0\n\nAttache keeps itself current.\n",
    artifacts: { "linux-x64": { name: ARCHIVE, size: ARCHIVE_BYTES.length, sha256: createHash("sha256").update(ARCHIVE_BYTES).digest("hex") } },
  };
  const file = join(folder, "attache-0.7.0-manifest.json");
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  return { folder, manifest: file };
}

describe("the release signing tool", () => {
  it("makes a key pair, signs a manifest, and verifies the release with the public key", () => {
    const keys = keyPair();
    expect(readFileSync(keys.privateKey, "utf8")).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(readFileSync(keys.publicKey, "utf8")).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    const release = releaseFolder();

    const signed = tool("sign", release.manifest, "--key", keys.privateKey);
    expect(signed.status, signed.err).toBe(0);
    expect(existsSync(`${release.manifest}.sig`)).toBe(true);

    const verified = tool("verify", release.folder, "--public-key", keys.publicKey);
    expect(verified.status, verified.err).toBe(0);
    expect(verified.out).toContain("Attache 0.7.0 (Stable) is signed with this key");
    expect(verified.out).toContain(ARCHIVE);
  });

  it("refuses a release signed with another key", () => {
    const keys = keyPair();
    const other = keyPair();
    const release = releaseFolder();
    tool("sign", release.manifest, "--key", keys.privateKey);

    const r = tool("verify", release.folder, "--public-key", other.publicKey);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("is not signed with Attache's key");
  });

  it("refuses a manifest changed by one byte after signing", () => {
    const keys = keyPair();
    const release = releaseFolder();
    tool("sign", release.manifest, "--key", keys.privateKey);
    writeFileSync(release.manifest, readFileSync(release.manifest, "utf8").replace("keeps itself current", "keeps itself currenT"));

    const r = tool("verify", release.folder, "--public-key", keys.publicKey);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("is not signed with Attache's key");
  });

  it("refuses an artifact changed by one byte after signing", () => {
    const keys = keyPair();
    const release = releaseFolder();
    tool("sign", release.manifest, "--key", keys.privateKey);
    const tampered = Buffer.from(ARCHIVE_BYTES);
    tampered[0] = tampered[0]! ^ 1;
    writeFileSync(join(release.folder, ARCHIVE), tampered);

    const r = tool("verify", release.folder, "--public-key", keys.publicKey);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain(`${ARCHIVE} does not match the signed manifest`);
  });

  it("never overwrites a key that already exists", () => {
    const keys = keyPair();
    const before = readFileSync(keys.privateKey, "utf8");
    const r = tool("keygen", keys.privateKey, keys.publicKey);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("already exists");
    expect(readFileSync(keys.privateKey, "utf8")).toBe(before);
  });
});

describe("the keys the release build is given", () => {
  const BUILD = join(import.meta.dirname, "..", "build-release.mjs");
  const build = (...args: string[]) => spawnSync(process.execPath, [BUILD, "--version", "0.7.0", ...args], { encoding: "utf8" });

  it("refuses to build without a signing key, saying how to make one", () => {
    const r = build();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--signing-key is missing: every release is signed");
  });

  it("refuses, before building, a signing key that does not belong to the public key it would build in", () => {
    const r = build("--signing-key", keyPair().privateKey, "--public-key", keyPair().publicKey);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("The signing key does not belong to the public key given to the build");
    expect(r.stdout).not.toContain("Building Attache");
  });

  it("refuses a version no release can carry", () => {
    const keys = keyPair();
    const r = spawnSync(process.execPath, [BUILD, "--version", "0.7.0-rc.1", "--signing-key", keys.privateKey, "--public-key", keys.publicKey], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("0.7.0-rc.1 is not a release version");
  });
});
