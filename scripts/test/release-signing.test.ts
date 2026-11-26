// The signing tool (scripts/release-signing.mjs), driven as the maintainer and the release workflow run it.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("sealing archives built elsewhere", () => {
  /** A folder with the three targets' archives, as the release workflow's build job hands them over. */
  function builtArchives() {
    const folder = mkdtempSync(join(tmpdir(), "attache-built-"));
    for (const name of ["attache-0.7.0-beta.1-macos-arm64.tar.gz", "attache-0.7.0-beta.1-linux-x64.tar.gz", "attache-0.7.0-beta.1-windows-x64.zip"]) writeFileSync(join(folder, name), `${name} bytes`);
    const notes = join(folder, "..", `notes-${Date.now()}.md`);
    writeFileSync(notes, "Attache keeps itself current.\n");
    return { folder, notes };
  }

  it("writes the signed manifest with the notes, the installers and SHA256SUMS, which the tool then verifies", () => {
    const keys = keyPair();
    const built = builtArchives();
    const sealed = tool("seal", built.folder, "--version", "0.7.0-beta.1", "--key", keys.privateKey, "--public-key", keys.publicKey, "--notes", built.notes);
    expect(sealed.status, sealed.err).toBe(0);
    const manifest = JSON.parse(readFileSync(join(built.folder, "attache-0.7.0-beta.1-manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ version: "0.7.0-beta.1", channel: "beta", notes: "Attache keeps itself current.\n" });
    expect(Object.keys(manifest.artifacts).sort()).toEqual(["linux-x64", "macos-arm64", "windows-x64"]);
    for (const f of ["attache-0.7.0-beta.1-manifest.json.sig", "SHA256SUMS", "Attache-Installer-0.7.0-beta.1-macos-arm64.command", "Attache-Installer-0.7.0-beta.1-linux-x64.sh", "Attache-Installer-0.7.0-beta.1-windows-x64.cmd"]) expect(existsSync(join(built.folder, f)), f).toBe(true);

    const verified = tool("verify", built.folder, "--public-key", keys.publicKey, "--version", "0.7.0-beta.1");
    expect(verified.status, verified.err).toBe(0);
    expect(verified.out).toContain("Attache 0.7.0-beta.1 (Beta) is signed with this key");
  });

  it("verifies that a release has every target the workflow builds", () => {
    const keys = keyPair();
    const built = builtArchives();
    rmSync(join(built.folder, "attache-0.7.0-beta.1-windows-x64.zip"));
    expect(tool("seal", built.folder, "--version", "0.7.0-beta.1", "--key", keys.privateKey, "--public-key", keys.publicKey).status).toBe(0);

    const r = tool("verify", built.folder, "--public-key", keys.publicKey, "--targets", "macos-arm64,linux-x64,windows-x64");
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("Attache 0.7.0-beta.1 has no release for windows-x64");
  });

  it("refuses a signing key that does not belong to the public key built into the archives", () => {
    const built = builtArchives();
    const r = tool("seal", built.folder, "--version", "0.7.0-beta.1", "--key", keyPair().privateKey, "--public-key", keyPair().publicKey);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("The signing key does not belong to the public key given to the build");
    expect(existsSync(join(built.folder, "attache-0.7.0-beta.1-manifest.json"))).toBe(false);
  });

  it("refuses an empty signing key, as a release environment without its secret gives", () => {
    const built = builtArchives();
    const empty = join(built.folder, "..", `empty-${Date.now()}.pem`);
    writeFileSync(empty, "");
    const r = tool("seal", built.folder, "--version", "0.7.0-beta.1", "--key", empty, "--public-key", keyPair().publicKey);
    expect(r.status).not.toBe(0);
    expect(r.err).toContain("is empty");
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

  it("builds unsealed archives without a signing key, for the release workflow to seal apart", () => {
    // A version no release can carry stops the build before it starts, after the keys are read.
    const r = spawnSync(process.execPath, [BUILD, "--version", "0.7.0-rc.1", "--unsealed", "--public-key", keyPair().publicKey], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toContain("--signing-key is missing");
    expect(r.stderr).toContain("0.7.0-rc.1 is not a release version");
  });

  it("still needs the public key to build into the service when unsealed", () => {
    const r = build("--unsealed");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("--public-key is missing");
  });

  it("refuses a version no release can carry", () => {
    const keys = keyPair();
    const r = spawnSync(process.execPath, [BUILD, "--version", "0.7.0-rc.1", "--signing-key", keys.privateKey, "--public-key", keys.publicKey], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("0.7.0-rc.1 is not a release version");
  });
});
